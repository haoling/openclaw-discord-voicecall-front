import * as prism from "prism-media";
import { config } from "./config";
import { userStates } from "./state";
import type { UserTranscriptionState } from "./types";
import { sendTranscriptionToChannel } from "./utils";
import { createDeepgramStream } from "./deepgram";

/**
 * 無音タイマーをリセット
 */
function resetSilenceTimer(userId: string) {
  const state = userStates.get(userId);
  if (!state) return;

  // 既存のタイマーをクリア
  if (state.silenceTimer) {
    clearTimeout(state.silenceTimer);
  }

  // 新しいタイマーを設定（1.5秒の無音で発話終了）
  // Deepgramのutterance_end_msと同じ値に設定
  state.silenceTimer = setTimeout(() => {
    if (state.currentTranscript.trim()) {
      // 文字起こし結果を送信
      sendTranscriptionToChannel(state.username, state.currentTranscript.trim());
      state.currentTranscript = "";
    }
    state.isSpeaking = false;
  }, 1500); // この値をconfigから取得するように変更
}

/**
 * 必要に応じてキープアライブメッセージを送信
 */
function sendKeepAliveIfNeeded(state: UserTranscriptionState, username: string) {
  const timeSinceLastKeepAlive = Date.now() - state.lastKeepAliveTime;
  if (timeSinceLastKeepAlive > config.KEEP_ALIVE_INTERVAL) {
    try {
      const readyState = state.deepgramStream.getReadyState();
      if (readyState === 1) {
        state.deepgramStream.send(JSON.stringify({ type: "KeepAlive" }));
        state.lastKeepAliveTime = Date.now();
        if (config.VERBOSE) {
          console.log(
            `[VERBOSE] ${username} | キープアライブ送信 (最終送信から${timeSinceLastKeepAlive}ms経過)`
          );
        }
      }
    } catch (error) {
      console.error(
        `[Deepgram] Error sending keepalive for ${username}:`,
        error
      );
    }
  }
}

/**
 * ユーザーの音声ストリームをリッスン
 */
export function listenToUser(userId: string, username: string, audioStream: import("@discordjs/voice").AudioReceiveStream) {
  console.log(`[Audio] Started listening to ${username}`);

  // ユーザーの状態を初期化
  const state: UserTranscriptionState = {
    userId,
    username,
    deepgramStream: createDeepgramStream(userId, username),
    lastAudioTime: Date.now(),
    silenceTimer: null,
    currentTranscript: "",
    isSpeaking: false,
    lastVerboseLog: Date.now(),
    totalSamples: 0,
    activeSamples: 0,
    reconnectAttempts: 0,
    lastReconnectTime: 0,
    lastSpeechFinal: null,
    silenceStartTime: null,
    isSendingToDeepgram: false,
    audioBuffer: [],
    lastKeepAliveTime: Date.now(),
    keepAliveTimer: null,
    finalTranscriptTimer: null,
    lastAudioDataTime: Date.now(),
  };
  userStates.set(userId, state);

  // 定期的なキープアライブタイマーを開始（無音時でもDeepgram接続を維持）
  state.keepAliveTimer = setInterval(() => {
    const currentState = userStates.get(userId);
    if (currentState) {
      sendKeepAliveIfNeeded(currentState, username);
    }
  }, config.KEEP_ALIVE_INTERVAL);

  // OpusデコーダーとPCM変換を設定
  const opusDecoder = new prism.opus.Decoder({
    rate: 48000,
    channels: 2,
    frameSize: 960,
  });

  // 音声ストリームをOpusデコーダーに接続
  // pipelineではなくpipeを使用することで、個別パケットのデコードエラーでストリーム全体が停止しないようにする
  audioStream.pipe(opusDecoder);

  // 最初のデータ受信をログ出力
  let firstDataReceived = false;
  let audioStreamDataCount = 0;
  let opusDecoderDataCount = 0;

  // audioStreamのデータ受信をモニタリング（デバッグ用）
  audioStream.on("data", (chunk: Buffer) => {
    audioStreamDataCount++;
    if (config.VERBOSE && audioStreamDataCount <= 5) {
      console.log(`[VERBOSE] ${username} | audioStream data #${audioStreamDataCount} (size: ${chunk.length} bytes)`);
    }
  });

  // Opusデコーダーのエラーハンドリング
  opusDecoder.on("error", (error: any) => {
    // Opusデコードエラーは個別のパケットの問題なので、ログ出力のみで継続
    // モバイル版Discordからの接続時に不正なパケットが送信されることがあるため
    if (config.VERBOSE) {
      console.log(`[Audio] Opus decode error for ${username} (ignoring packet):`, error.message);
    }
    // デコードに失敗したパケットは破棄し、ストリームは継続
    // エラーイベントをキャッチすることで、ストリームが停止しないようにする
  });

  // Opusデコーダーのライフサイクルイベント（デバッグ用）
  opusDecoder.on("end", () => {
    console.log(`[Audio] OpusDecoder ended for ${username}`);
  });
  opusDecoder.on("close", () => {
    console.log(`[Audio] OpusDecoder closed for ${username}`);
  });
  opusDecoder.on("finish", () => {
    console.log(`[Audio] OpusDecoder finished for ${username}`);
  });

  opusDecoder.on("data", (pcmData: Buffer) => {
    // 音声データ受信時刻を更新
    state.lastAudioDataTime = Date.now();
    opusDecoderDataCount++;

    if (!firstDataReceived) {
      firstDataReceived = true;
      console.log(
        `[Audio] First PCM data received for ${username} (size: ${pcmData.length} bytes)`
      );
      if (config.VERBOSE) {
        console.log(
          `[VERBOSE] ${username} | 音声データ受信開始 (サンプリングレート: 48000Hz, チャンネル数: 2)`
        );
      }
    } else if (config.VERBOSE && opusDecoderDataCount <= 5) {
      console.log(`[VERBOSE] ${username} | opusDecoder data #${opusDecoderDataCount} (size: ${pcmData.length} bytes)`);
    }

    // ローカルVAD: 音量レベルを計算（環境雑音を無視するため）
    let averageVolume = 0;
    let shouldSendAudio = true; // デフォルトは送信する

    if (config.ENABLE_LOCAL_VAD) {
      // ローカルVADが有効な場合、音量閾値で判断
      const samples = new Int16Array(
        pcmData.buffer,
        pcmData.byteOffset,
        pcmData.length / 2
      );
      let sum = 0;
      for (let i = 0; i < samples.length; i++) {
        sum += Math.abs(samples[i]);
      }
      averageVolume = sum / samples.length;

      // VERBOSE モード：統計情報を収集
      if (config.VERBOSE) {
        state.totalSamples++;
        if (averageVolume > config.VOLUME_THRESHOLD) {
          state.activeSamples++;
        }

        // 1秒ごとにログ出力
        const now = Date.now();
        if (now - state.lastVerboseLog >= 1000) {
          const activePercentage =
            state.totalSamples > 0
              ? ((state.activeSamples / state.totalSamples) * 100).toFixed(1)
              : "0.0";
          console.log(
            `[VERBOSE] ${username} | ローカルVAD: 有効 | 音量: ${averageVolume.toFixed(0)} | ` +
              `閾値: ${config.VOLUME_THRESHOLD} | ` +
              `音声検出: ${averageVolume > config.VOLUME_THRESHOLD ? "✓" : "✗"} | ` +
              `アクティブ率: ${activePercentage}% (${state.activeSamples}/${state.totalSamples})`
          );
          state.lastVerboseLog = now;
          state.totalSamples = 0;
          state.activeSamples = 0;
        }
      }

      // 音量閾値で判定
      shouldSendAudio = averageVolume > config.VOLUME_THRESHOLD;
    } else {
      // ローカルVADが無効な場合、すべての音声をDeepgramに送信
      if (config.VERBOSE) {
        state.totalSamples++;
        const now = Date.now();
        if (now - state.lastVerboseLog >= 1000) {
          console.log(
            `[VERBOSE] ${username} | ローカルVAD: 無効 | すべての音声をDeepgramに送信中 (サンプル数: ${state.totalSamples})`
          );
          state.lastVerboseLog = now;
          state.totalSamples = 0;
        }
      }
    }

    // 音声データ送信ロジック
    if (config.ENABLE_LOCAL_VAD) {
      // ローカルVAD有効時: バッファリングと新しいロジック

      // 常にバッファにpcmDataを追加（発話の立ち上がり部分を捉えるため）
      if (!state.isSendingToDeepgram) {
        state.audioBuffer.push(pcmData);
        if (state.audioBuffer.length > config.AUDIO_BUFFER_SIZE) {
          state.audioBuffer.shift(); // 古いデータを削除
        }
      }

      if (averageVolume > config.VOLUME_THRESHOLD) {
        // 音声検出
        if (!state.isSpeaking) {
          state.isSpeaking = true;
          if (config.VERBOSE) {
            console.log(`[VERBOSE] ${username} | 音声検出: 発話開始`);
          }
        }

        // 音声検出時は常に無音タイマーをリセット（無音中に音声再開した場合も含む）
        if (state.silenceStartTime !== null) {
          if (config.VERBOSE) {
            console.log(
              `[VERBOSE] ${username} | 無音中に音声再開、無音タイマーをリセット`
            );
          }
        }
        state.silenceStartTime = null;

        if (!state.isSendingToDeepgram) {
          // 新しい発話開始、Deepgramへの送信を開始
          state.isSendingToDeepgram = true;

          // 前の発話の未送信テキストは送信せず、継続して蓄積する
          // （無音検出で基準時間経過したときに送信される）

          // バッファの内容を先に送信（発話の立ち上がり部分を含める）
          try {
            const readyState = state.deepgramStream.getReadyState();
            if (readyState === 1) {
              if (config.VERBOSE) {
                console.log(
                  `[VERBOSE] ${username} | 新しい発話開始、バッファから${state.audioBuffer.length}フレームを送信`
                );
              }
              for (const bufferedData of state.audioBuffer) {
                state.deepgramStream.send(bufferedData);
              }
              state.audioBuffer = []; // バッファをクリア
            }
          } catch (error) {
            console.error(
              `[Deepgram] Error sending buffered data for ${username}:`,
              error
            );
          }
        }

        // speech_final: true が返ってくるまで送信し続ける
        if (state.isSendingToDeepgram) {
          try {
            const readyState = state.deepgramStream.getReadyState();
            if (readyState === 1) {
              state.deepgramStream.send(pcmData);
              state.lastKeepAliveTime = Date.now(); // キープアライブタイムスタンプを更新
              if (config.VERBOSE && state.totalSamples % 10 === 0) {
                console.log(
                  `[VERBOSE] ${username} | Deepgramへ送信中 (ReadyState: ${readyState}, サンプルサイズ: ${pcmData.length}バイト)`
                );
              }
            } else if (readyState === 0) {
              if (config.VERBOSE && state.totalSamples % 50 === 0) {
                console.log(
                  `[VERBOSE] ${username} | Deepgram接続待機中 (ReadyState: ${readyState})`
                );
              }
            } else {
              console.log(
                `[Deepgram] Not ready to send data for ${username}, state: ${readyState}`
              );
            }
          } catch (error) {
            console.error(
              `[Deepgram] Error sending data for ${username}:`,
              error
            );
          }
        }
      } else {
        // 無音検出
        if (state.isSpeaking) {
          // 無音開始時刻を記録
          if (!state.silenceStartTime) {
            state.silenceStartTime = Date.now();
            if (config.VERBOSE) {
              console.log(`[VERBOSE] ${username} | 無音開始を検出`);
            }
          }

          const silenceDuration = Date.now() - state.silenceStartTime;

          // speech_finalの値に関わらず、BASE_SILENCE_TIME経過でログ送信
          if (silenceDuration >= config.BASE_SILENCE_TIME) {
            // 無音が基準時間続いた → ログ送信
            if (state.currentTranscript.trim()) {
              if (config.VERBOSE) {
                console.log(
                  `[VERBOSE] ${username} | 無音${silenceDuration}ms経過 → ログ送信: "${state.currentTranscript.trim()}"`
                );
              }
              sendTranscriptionToChannel(
                state.username,
                state.currentTranscript.trim()
              );
              state.currentTranscript = "";
            }
            state.isSpeaking = false;
            state.isSendingToDeepgram = false;
            state.silenceStartTime = null;
            state.audioBuffer = []; // バッファをクリア
          } else if (state.isSendingToDeepgram) {
            // まだ無音時間が足りない → 送信継続
            try {
              const readyState = state.deepgramStream.getReadyState();
              if (readyState === 1) {
                state.deepgramStream.send(pcmData);
                state.lastKeepAliveTime = Date.now(); // キープアライブタイムスタンプを更新
                if (config.VERBOSE && state.totalSamples % 10 === 0) {
                  console.log(
                    `[VERBOSE] ${username} | 無音中だがDeepgramへ送信継続 (無音: ${silenceDuration}ms)`
                  );
                }
              }
            } catch (error) {
              console.error(
                `[Deepgram] Error sending data for ${username}:`,
                error
              );
            }

            // 無音検出中もキープアライブを送信（Deepgramタイムアウト防止）
            sendKeepAliveIfNeeded(state, username);
          } else {
            // isSendingToDeepgramがfalseの場合もキープアライブを送信
            sendKeepAliveIfNeeded(state, username);
          }
        } else {
          // 発話していない無音時のキープアライブ
          sendKeepAliveIfNeeded(state, username);
        }
      }
    } else {
      // ローカルVAD無効時: 既存ロジック
      if (shouldSendAudio) {
        state.lastAudioTime = Date.now();

        // 発話開始を検出
        if (!state.isSpeaking) {
          state.isSpeaking = true;
          if (config.VERBOSE) {
            console.log(`[VERBOSE] ${username} | 発話開始を検出`);
          }
        }

        // Deepgramに音声データを送信
        try {
          const readyState = state.deepgramStream.getReadyState();
          if (readyState === 1) {
            state.deepgramStream.send(pcmData);
            state.lastKeepAliveTime = Date.now(); // キープアライブタイムスタンプを更新
            if (config.VERBOSE) {
              // 10サンプルに1回だけログ出力（ログの洪水を避ける）
              if (state.totalSamples % 10 === 0) {
                console.log(
                  `[VERBOSE] ${username} | Deepgramへ送信中 (ReadyState: ${readyState}, サンプルサイズ: ${pcmData.length}バイト)`
                );
              }
            }
          } else if (readyState === 0) {
            // 接続中なので待機
            if (config.VERBOSE && state.totalSamples % 50 === 0) {
              console.log(
                `[VERBOSE] ${username} | Deepgram接続待機中 (ReadyState: ${readyState})`
              );
            }
          } else {
            console.log(
              `[Deepgram] Not ready to send data for ${username}, state: ${readyState}`
            );
          }
        } catch (error) {
          console.error(
            `[Deepgram] Error sending data for ${username}:`,
            error
          );
        }

        // 無音タイマーをリセット
        resetSilenceTimer(userId);
      } else {
        // 音量が閾値以下の場合、発話終了をチェック（ローカルVAD有効時のみ）
        if (config.ENABLE_LOCAL_VAD && state.isSpeaking && config.VERBOSE) {
          // 発話中から無音になった時のみログ出力
          const timeSinceLastAudio = Date.now() - state.lastAudioTime;
          if (timeSinceLastAudio > 500) {
            // 500ms以上無音
            console.log(`[VERBOSE] ${username} | 無音期間: ${timeSinceLastAudio}ms`);
          }
        }

        // キープアライブ送信
        sendKeepAliveIfNeeded(state, username);
      }
    }
  });

  // audioStreamのエラーハンドリング
  audioStream.on("error", (error: any) => {
    // Opusデコードエラーの場合は、個別のパケットの問題なのでクリーンアップしない
    // モバイル版Discordからの接続時に不正なパケットが送信されることがある
    if (error.message && error.message.includes("Decode error")) {
      if (config.VERBOSE) {
        console.log(`[Audio] Stream decode error for ${username} (ignoring packet):`, error.message);
      }
      // デコードに失敗したパケットは破棄し、ストリームは継続
      return;
    }

    // その他のエラーの場合はクリーンアップ
    console.error(`[Audio] Stream error for ${username}:`, error);
    cleanupUserState(userId);
  });

  // audioStreamの終了イベント
  audioStream.on("end", () => {
    console.log(`[Audio] Stream ended for ${username}`);
    cleanupUserState(userId);
  });
}

/**
 * ユーザーの状態をクリーンアップ
 */
export function cleanupUserState(userId: string) {
  const state = userStates.get(userId);
  if (!state) return;

  // タイマーをクリア
  if (state.silenceTimer) {
    clearTimeout(state.silenceTimer);
  }
  if (state.finalTranscriptTimer) {
    clearTimeout(state.finalTranscriptTimer);
  }
  if (state.keepAliveTimer) {
    clearInterval(state.keepAliveTimer);
  }

  // 残りの文字起こし結果を送信
  if (state.currentTranscript.trim()) {
    sendTranscriptionToChannel(state.username, state.currentTranscript.trim());
  }

  // Deepgram接続をクローズ
  if (state.deepgramStream) {
    state.deepgramStream.finish();
  }

  // 状態を削除
  userStates.delete(userId);
  console.log(`[Cleanup] Cleaned up state for ${state.username}`);
}
