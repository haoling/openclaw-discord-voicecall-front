import { Client, GatewayIntentBits, TextChannel } from "discord.js";
import {
  joinVoiceChannel,
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  type VoiceConnection,
} from "@discordjs/voice";
import { pipeline } from "stream";
import * as prism from "prism-media";
import * as sodium from "libsodium-wrappers";

// 環境変数の読み込み
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN!;
const DISCORD_LOG_CHANNEL_ID = process.env.DISCORD_LOG_CHANNEL_ID!;
const DISCORD_VOICE_CHANNEL_ID = process.env.DISCORD_VOICE_CHANNEL_ID!;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY!;
const VERBOSE = process.env.VERBOSE === "true";
const ENABLE_DEEPGRAM_VAD = process.env.ENABLE_DEEPGRAM_VAD !== "false"; // デフォルトはtrue
const ENABLE_LOCAL_VAD = process.env.ENABLE_LOCAL_VAD !== "false"; // デフォルトはtrue
const BASE_SILENCE_TIME = parseInt(process.env.BASE_SILENCE_TIME || "1500", 10); // 無音判定の基準時間（環境変数で設定可能、デフォルト: 1500ms）
const VOLUME_THRESHOLD = parseInt(process.env.VOLUME_THRESHOLD || "150", 10); // 音量閾値（環境変数で設定可能、デフォルト: 150）
const AUDIO_BUFFER_SIZE = 30; // オーディオバッファサイズ（約600ms分、20msフレーム × 30）

// 環境変数の検証
if (!DISCORD_BOT_TOKEN) {
  console.error("Error: DISCORD_BOT_TOKEN is not set");
  process.exit(1);
}

if (!DISCORD_LOG_CHANNEL_ID) {
  console.error("Error: DISCORD_LOG_CHANNEL_ID is not set");
  process.exit(1);
}

if (!DISCORD_VOICE_CHANNEL_ID) {
  console.error("Error: DISCORD_VOICE_CHANNEL_ID is not set");
  process.exit(1);
}

if (!DEEPGRAM_API_KEY) {
  console.error("Error: DEEPGRAM_API_KEY is not set");
  process.exit(1);
}

// 起動時に環境変数の状態を出力
console.log("=== 環境変数の状態 ===");
console.log(`VERBOSE: ${VERBOSE}`);
console.log(`ENABLE_DEEPGRAM_VAD: ${ENABLE_DEEPGRAM_VAD} (Deepgramサーバー側のVAD)`);
console.log(`ENABLE_LOCAL_VAD: ${ENABLE_LOCAL_VAD} (ローカル音量閾値ベースのVAD)`);
console.log(`DISCORD_BOT_TOKEN: ${DISCORD_BOT_TOKEN ? "設定済み" : "未設定"}`);
console.log(
  `DISCORD_LOG_CHANNEL_ID: ${DISCORD_LOG_CHANNEL_ID ? DISCORD_LOG_CHANNEL_ID : "未設定"}`
);
console.log(
  `DISCORD_VOICE_CHANNEL_ID: ${DISCORD_VOICE_CHANNEL_ID ? DISCORD_VOICE_CHANNEL_ID : "未設定"}`
);
console.log(
  `DEEPGRAM_API_KEY: ${DEEPGRAM_API_KEY ? `${DEEPGRAM_API_KEY.substring(0, 8)}...` : "未設定"}`
);
console.log("====================");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates, // ボイスチャンネルの状態変更を監視するために必要
  ],
});

// ログチャンネルをキャッシュ（起動時に一度だけフェッチ）
let cachedLogChannel: TextChannel | null = null;
let voiceConnection: VoiceConnection | null = null;

// ユーザーごとの音声認識状態を管理
interface UserTranscriptionState {
  userId: string;
  username: string;
  deepgramStream: LiveTranscriptionConnection;
  lastAudioTime: number;
  silenceTimer: NodeJS.Timeout | null;
  currentTranscript: string;
  isSpeaking: boolean;
  lastVerboseLog: number; // VERBOSE モード用：最後のログ出力時刻
  totalSamples: number; // VERBOSE モード用：処理したサンプル数
  activeSamples: number; // VERBOSE モード用：閾値を超えたサンプル数
  reconnectAttempts: number; // Deepgram再接続試行回数
  lastReconnectTime: number; // 最後の再接続時刻
  lastSpeechFinal: boolean | null; // Deepgramから最後に受信したspeech_finalの値
  silenceStartTime: number | null; // 無音開始時刻
  isSendingToDeepgram: boolean; // Deepgramに音声データを送信中かどうか
  audioBuffer: Buffer[]; // 発話の立ち上がり部分を捉えるためのバッファ
}

const userStates = new Map<string, UserTranscriptionState>();

/**
 * 日本時間のタイムスタンプを生成するヘルパー関数
 */
function getJapaneseTimestamp(): string {
  const now = new Date();
  return now.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * ボイスログチャンネルに文字起こしを投稿
 */
async function sendTranscriptionToChannel(
  username: string,
  transcript: string
) {
  if (!cachedLogChannel || !transcript.trim()) return;

  try {
    const timestamp = getJapaneseTimestamp();
    const message = `💬 **${username}** — ${timestamp}\n${transcript}`;
    await cachedLogChannel.send(message);
    console.log(`[Transcription] ${username}: ${transcript}`);
  } catch (error) {
    console.error("Error sending transcription:", error);
  }
}

/**
 * Deepgramストリームを作成
 */
function createDeepgramStream(userId: string, username: string) {
  console.log(`[Deepgram] Creating stream for ${username}`);
  console.log(
    `[Deepgram] API Key check: ${DEEPGRAM_API_KEY ? `${DEEPGRAM_API_KEY.substring(0, 8)}...` : "NOT SET"}`
  );
  console.log(`[Deepgram] Deepgram VAD enabled: ${ENABLE_DEEPGRAM_VAD}`);

  const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
  const deepgram = createClient(DEEPGRAM_API_KEY);

  console.log(`[Deepgram] Client created, establishing live connection...`);

  const dgConnection = deepgram.listen.live({
    model: "nova-3",
    language: "ja",
    encoding: "linear16",
    sample_rate: 48000,
    channels: 2,
    interim_results: true, // 中間結果も取得（より早く応答を得る）
    utterance_end_ms: 1500, // 1.5秒の無音で発話終了と判断
    vad_events: ENABLE_DEEPGRAM_VAD, // Deepgram側のVADイベント（環境変数で制御）
    smart_format: true, // スマートフォーマット（句読点など）
    no_delay: true, // 遅延を最小化
  });

  console.log(
    `[Deepgram] Live connection object created for ${username}, initial state: ${dgConnection.getReadyState()}`
  );

  // 公式例に従い、Openイベント内で他のイベントリスナーを登録
  dgConnection.on(LiveTranscriptionEvents.Open, () => {
    console.log(
      `[Deepgram] ✓ Connection opened for ${username}, ready state: ${dgConnection.getReadyState()}`
    );
    if (VERBOSE) {
      console.log(`[VERBOSE] ${username} | Deepgram接続完了、文字起こし開始可能`);
    }

    // 接続が成功したら再接続カウンターをリセット
    const state = userStates.get(userId);
    if (state) {
      state.reconnectAttempts = 0;
    }

    // Openイベント内でTranscript, Error, Closeイベントを登録
    dgConnection.on(LiveTranscriptionEvents.Transcript, (data: any) => {
      const transcript = data.channel?.alternatives?.[0]?.transcript;
      const isFinal = data.is_final;
      const speechFinal = data.speech_final;

      if (VERBOSE) {
        console.log(
          `[VERBOSE] ${username} | Deepgramからの応答 (is_final: ${isFinal}, speech_final: ${speechFinal}):`,
          transcript || "(空)"
        );
      }

      const state = userStates.get(userId);

      // speech_finalの状態を記録
      if (state && speechFinal !== undefined) {
        state.lastSpeechFinal = speechFinal;
        if (VERBOSE) {
          console.log(
            `[VERBOSE] ${username} | speech_finalを更新: ${speechFinal}`
          );
        }
      }

      // 最終結果のみを使用（中間結果は無視）
      if (transcript && transcript.trim() && isFinal) {
        console.log(
          `[Deepgram] Final transcript for ${username}: "${transcript}"`
        );
        if (state) {
          // 文字起こし結果を累積
          state.currentTranscript += transcript + " ";
        }
      } else if (VERBOSE && transcript && transcript.trim()) {
        console.log(
          `[VERBOSE] ${username} | 中間結果（無視）: "${transcript}"`
        );
      } else if (VERBOSE && !transcript) {
        console.log(`[VERBOSE] ${username} | 空の文字起こし結果を受信`);
      }
    });

    dgConnection.on(LiveTranscriptionEvents.Error, (error: any) => {
      console.error(`[Deepgram] Error for ${username}:`, {
        type: error.type,
        message: error.message,
        error: error.error,
        reason: error.reason,
        code: error.code,
        details: JSON.stringify(error, null, 2),
      });
    });

    dgConnection.on(LiveTranscriptionEvents.Close, (event: any) => {
      console.log(`[Deepgram] Connection closed for ${username}:`, {
        code: event?.code,
        reason: event?.reason,
        wasClean: event?.wasClean,
      });

      // タイムアウトや予期しないクローズの場合は再接続を試みる
      // code: 1011 はタイムアウト、1006 は異常クローズ
      const state = userStates.get(userId);
      if (
        state &&
        (event?.code === 1011 || event?.code === 1006 || event?.code === 1000)
      ) {
        const now = Date.now();
        const timeSinceLastReconnect = now - state.lastReconnectTime;

        // 再接続回数が5回未満で、前回の再接続から5秒以上経過している場合のみ再接続
        if (state.reconnectAttempts < 5 && timeSinceLastReconnect > 5000) {
          console.log(
            `[Deepgram] Attempting to reconnect for ${username} (close code: ${event?.code}, attempt: ${state.reconnectAttempts + 1}/5)...`
          );

          // 少し待ってから再接続（exponential backoff）
          const delay = Math.min(1000 * Math.pow(2, state.reconnectAttempts), 10000);
          setTimeout(() => {
            const currentState = userStates.get(userId);
            if (currentState) {
              // 新しいDeepgram接続を作成
              const newConnection = createDeepgramStream(userId, username);
              currentState.deepgramStream = newConnection;
              currentState.reconnectAttempts++;
              currentState.lastReconnectTime = Date.now();
              console.log(
                `[Deepgram] Reconnection initiated for ${username} (delay: ${delay}ms)`
              );
            }
          }, delay);
        } else if (state.reconnectAttempts >= 5) {
          console.error(
            `[Deepgram] Max reconnection attempts reached for ${username}`
          );
        } else {
          console.log(
            `[Deepgram] Skipping reconnection for ${username} (too soon since last attempt)`
          );
        }
      }
    });
  });

  return dgConnection;
}

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
  }, 1500);
}

/**
 * ユーザーの音声ストリームをリッスン
 */
function listenToUser(userId: string, username: string, audioStream: any) {
  console.log(`[Audio] Started listening to ${username}`);

  // ユーザーの状態を初期化
  const deepgramStream = createDeepgramStream(userId, username);
  const state: UserTranscriptionState = {
    userId,
    username,
    deepgramStream,
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
  };
  userStates.set(userId, state);

  // OpusデコーダーとPCM変換を設定
  const opusDecoder = new prism.opus.Decoder({
    rate: 48000,
    channels: 2,
    frameSize: 960,
  });

  // 音声データをDeepgramに送信
  pipeline(audioStream, opusDecoder, (err) => {
    if (err) {
      console.error(`[Audio] Pipeline error for ${username}:`, err);
    }
  });

  // 最初のデータ受信をログ出力
  let firstDataReceived = false;

  opusDecoder.on("data", (pcmData: Buffer) => {
    if (!firstDataReceived) {
      firstDataReceived = true;
      console.log(
        `[Audio] First PCM data received for ${username} (size: ${pcmData.length} bytes)`
      );
      if (VERBOSE) {
        console.log(
          `[VERBOSE] ${username} | 音声データ受信開始 (サンプリングレート: 48000Hz, チャンネル数: 2)`
        );
      }
    }

    // ローカルVAD: 音量レベルを計算（環境雑音を無視するため）
    let averageVolume = 0;
    let shouldSendAudio = true; // デフォルトは送信する

    if (ENABLE_LOCAL_VAD) {
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
      if (VERBOSE) {
        state.totalSamples++;
        if (averageVolume > VOLUME_THRESHOLD) {
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
            `[VERBOSE] ${username} | ローカルVAD: 有効 | 音量: ${averageVolume.toFixed(0)} | 閾値: ${VOLUME_THRESHOLD} | ` +
              `音声検出: ${averageVolume > VOLUME_THRESHOLD ? "✓" : "✗"} | ` +
              `アクティブ率: ${activePercentage}% (${state.activeSamples}/${state.totalSamples})`
          );
          state.lastVerboseLog = now;
          state.totalSamples = 0;
          state.activeSamples = 0;
        }
      }

      shouldSendAudio = averageVolume > VOLUME_THRESHOLD;
    } else {
      // ローカルVADが無効な場合、すべての音声をDeepgramに送信
      if (VERBOSE) {
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
    if (ENABLE_LOCAL_VAD) {
      // ローカルVAD有効時: バッファリングと新しいロジック

      // 常にバッファにpcmDataを追加（発話の立ち上がり部分を捉えるため）
      if (!state.isSendingToDeepgram) {
        state.audioBuffer.push(pcmData);
        if (state.audioBuffer.length > AUDIO_BUFFER_SIZE) {
          state.audioBuffer.shift(); // 古いデータを削除
        }
      }

      if (averageVolume > VOLUME_THRESHOLD) {
        // 音声検出
        if (!state.isSpeaking) {
          state.isSpeaking = true;
          if (VERBOSE) {
            console.log(`[VERBOSE] ${username} | 音声検出: 発話開始`);
          }
        }

        // 音声検出時は常に無音タイマーをリセット（無音中に音声再開した場合も含む）
        if (state.silenceStartTime !== null) {
          if (VERBOSE) {
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
            const readyState = deepgramStream.getReadyState();
            if (readyState === 1) {
              if (VERBOSE) {
                console.log(
                  `[VERBOSE] ${username} | 新しい発話開始、バッファから${state.audioBuffer.length}フレームを送信`
                );
              }
              for (const bufferedData of state.audioBuffer) {
                deepgramStream.send(bufferedData);
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
            const readyState = deepgramStream.getReadyState();
            if (readyState === 1) {
              deepgramStream.send(pcmData);
              if (VERBOSE && state.totalSamples % 10 === 0) {
                console.log(
                  `[VERBOSE] ${username} | Deepgramへ送信中 (ReadyState: ${readyState}, サンプルサイズ: ${pcmData.length}バイト)`
                );
              }
            } else if (readyState === 0) {
              if (VERBOSE && state.totalSamples % 50 === 0) {
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
            if (VERBOSE) {
              console.log(`[VERBOSE] ${username} | 無音開始を検出`);
            }
          }

          const silenceDuration = Date.now() - state.silenceStartTime;

          // speech_finalの値に関わらず、BASE_SILENCE_TIME経過でログ送信
          if (silenceDuration >= BASE_SILENCE_TIME) {
            // 無音が基準時間続いた → ログ送信
            if (state.currentTranscript.trim()) {
              if (VERBOSE) {
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
              const readyState = deepgramStream.getReadyState();
              if (readyState === 1) {
                deepgramStream.send(pcmData);
                if (VERBOSE && state.totalSamples % 10 === 0) {
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
          }
        }
      }
    } else {
      // ローカルVAD無効時: 既存ロジック
      if (shouldSendAudio) {
        state.lastAudioTime = Date.now();

        // 発話開始を検出
        if (!state.isSpeaking) {
          state.isSpeaking = true;
          if (VERBOSE) {
            console.log(`[VERBOSE] ${username} | 発話開始を検出`);
          }
        }

        // Deepgramに音声データを送信
        try {
          const readyState = deepgramStream.getReadyState();
          if (readyState === 1) {
            deepgramStream.send(pcmData);
            if (VERBOSE) {
              // 10サンプルに1回だけログ出力（ログの洪水を避ける）
              if (state.totalSamples % 10 === 0) {
                console.log(
                  `[VERBOSE] ${username} | Deepgramへ送信中 (ReadyState: ${readyState}, サンプルサイズ: ${pcmData.length}バイト)`
                );
              }
            }
          } else if (readyState === 0) {
            // 接続中なので待機
            if (VERBOSE && state.totalSamples % 50 === 0) {
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
        if (ENABLE_LOCAL_VAD && state.isSpeaking && VERBOSE) {
          // 発話中から無音になった時のみログ出力
          const timeSinceLastAudio = Date.now() - state.lastAudioTime;
          if (timeSinceLastAudio > 500) {
            // 500ms以上無音
            console.log(`[VERBOSE] ${username} | 無音期間: ${timeSinceLastAudio}ms`);
          }
        }
      }
    }
  });

  audioStream.on("end", () => {
    console.log(`[Audio] Stream ended for ${username}`);
    cleanupUserState(userId);
  });

  audioStream.on("error", (error: any) => {
    console.error(`[Audio] Stream error for ${username}:`, error);
    cleanupUserState(userId);
  });
}

/**
 * ユーザーの状態をクリーンアップ
 */
function cleanupUserState(userId: string) {
  const state = userStates.get(userId);
  if (!state) return;

  // タイマーをクリア
  if (state.silenceTimer) {
    clearTimeout(state.silenceTimer);
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

/**
 * ボイスチャンネルに接続
 */
async function connectToVoiceChannel() {
  try {
    console.log(`[Voice] Fetching voice channel: ${DISCORD_VOICE_CHANNEL_ID}`);
    const channel = await client.channels.fetch(DISCORD_VOICE_CHANNEL_ID);
    if (!channel || !channel.isVoiceBased()) {
      throw new Error("Invalid voice channel");
    }

    console.log(`[Voice] Joining voice channel: ${channel.name}`);
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator as InternalDiscordGatewayAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });

    console.log(
      `[Voice] Waiting for connection to be ready (timeout: 60s)...`
    );
    console.log(
      `[Voice] Current state: ${connection.state.status}`
    );

    // 接続が確立されるまで待機（タイムアウトを60秒に延長）
    await entersState(connection, VoiceConnectionStatus.Ready, 60_000);
    console.log(`[Voice] ✓ Connected to voice channel: ${channel.name}`);

    voiceConnection = connection;

    // 接続状態の変化をログ出力
    connection.on("stateChange", (oldState, newState) => {
      console.log(
        `[Voice] State change: ${oldState.status} -> ${newState.status}`
      );
      if (VERBOSE) {
        console.log(`[VERBOSE] Voice connection state details:`, {
          old: oldState,
          new: newState,
        });
      }
    });

    // 音声受信を開始
    const receiver = connection.receiver;

    console.log(`[Voice] Voice receiver initialized, waiting for users to speak...`);

    receiver.speaking.on("start", (userId) => {
      console.log(`[Voice] Speaking event detected for user ID: ${userId}`);

      // ユーザーが話し始めたら音声ストリームをリッスン
      const user = client.users.cache.get(userId);
      if (!user) {
        console.log(`[Voice] User not found in cache: ${userId}`);
        return;
      }

      if (user.bot) {
        console.log(`[Voice] Ignoring bot user: ${user.username}`);
        return;
      }

      const username = user.username;
      console.log(`[Voice] User ${username} started speaking`);

      // 既にリスニング中でなければ開始
      if (!userStates.has(userId)) {
        console.log(`[Voice] Starting new audio stream for ${username}`);
        const audioStream = receiver.subscribe(userId, {
          end: {
            behavior: EndBehaviorType.Manual,
          },
        });
        listenToUser(userId, username, audioStream);
      } else {
        console.log(`[Voice] Already listening to ${username}`);
      }
    });

    // 接続エラーハンドリング
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      console.log("[Voice] Disconnected from voice channel");
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        connection.destroy();
        voiceConnection = null;
        // 全ユーザーの状態をクリーンアップ
        for (const userId of userStates.keys()) {
          cleanupUserState(userId);
        }
        console.log("[Voice] Connection destroyed");
      }
    });

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      console.log("[Voice] Connection destroyed");
      voiceConnection = null;
      // 全ユーザーの状態をクリーンアップ
      for (const userId of userStates.keys()) {
        cleanupUserState(userId);
      }
    });

    if (cachedLogChannel) {
      await cachedLogChannel.send(
        `🎙️ ボイスチャンネル接続 — ${getJapaneseTimestamp()}\nボットがボイスチャンネルに接続し、音声認識を開始しました。`
      );
    }
  } catch (error) {
    console.error("[Voice] Failed to connect to voice channel:", error);
  }
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user?.tag}`);

  try {
    const channel = await client.channels.fetch(DISCORD_LOG_CHANNEL_ID);

    if (!channel) {
      throw new Error(`Channel not found: ${DISCORD_LOG_CHANNEL_ID}`);
    }

    if (!(channel instanceof TextChannel)) {
      throw new Error(`Channel is not a text channel: ${DISCORD_LOG_CHANNEL_ID}`);
    }

    // ログチャンネルをキャッシュに保存
    cachedLogChannel = channel;

    const timestamp = getJapaneseTimestamp();
    const message = `🤖 Bot起動確認 — ${timestamp}\nDiscord Voice Bot が正常に起動しました。`;

    await channel.send(message);
    console.log(`Message sent to #${channel.name}`);
    console.log("Voice state monitoring started.");

    // ボイスチャンネルに接続
    await connectToVoiceChannel();
  } catch (error) {
    console.error("An error occurred during startup:", error);
    process.exitCode = 1;
  }
});

// ボイスチャンネルの入退室を監視
client.on("voiceStateUpdate", async (oldState, newState) => {
  try {
    // キャッシュされたログチャンネルを使用（毎回フェッチしない）
    if (!cachedLogChannel) {
      console.error("Log channel not cached yet");
      return;
    }

    const member = newState.member || oldState.member;
    if (!member) return;

    const timestamp = getJapaneseTimestamp();

    // イベントタイプに基づいてメッセージ内容を決定
    let message: string | null = null;
    let consoleLog: string | null = null;

    // ボイスチャンネルに参加した場合
    if (!oldState.channel && newState.channel) {
      message = `🔊 **ボイスチャンネル参加** — ${timestamp}\n👤 **ユーザー:** ${member.user.tag}\n📢 **チャンネル:** ${newState.channel.name}`;
      consoleLog = `${member.user.tag} joined ${newState.channel.name}`;
    }
    // ボイスチャンネルから退出した場合
    else if (oldState.channel && !newState.channel) {
      message = `🔇 **ボイスチャンネル退出** — ${timestamp}\n👤 **ユーザー:** ${member.user.tag}\n📢 **チャンネル:** ${oldState.channel.name}`;
      consoleLog = `${member.user.tag} left ${oldState.channel.name}`;

      // ユーザーが退出したら、その音声認識状態をクリーンアップ
      cleanupUserState(member.user.id);
    }
    // ボイスチャンネル間を移動した場合
    else if (
      oldState.channel &&
      newState.channel &&
      oldState.channel.id !== newState.channel.id
    ) {
      message = `🔀 **ボイスチャンネル移動** — ${timestamp}\n👤 **ユーザー:** ${member.user.tag}\n📤 **移動元:** ${oldState.channel.name}\n📥 **移動先:** ${newState.channel.name}`;
      consoleLog = `${member.user.tag} moved from ${oldState.channel.name} to ${newState.channel.name}`;

      // ユーザーが移動したら、音声認識状態をクリーンアップ
      cleanupUserState(member.user.id);
    }

    // メッセージがある場合のみ送信とログ出力
    if (message && consoleLog) {
      await cachedLogChannel.send(message);
      console.log(consoleLog);
    }
  } catch (error) {
    console.error("Error in voiceStateUpdate handler:", error);
  }
});

// プロセス終了時のクリーンアップ
process.on("SIGINT", () => {
  console.log("\n[Shutdown] Cleaning up...");

  // 全ユーザーの状態をクリーンアップ
  for (const userId of userStates.keys()) {
    cleanupUserState(userId);
  }

  // ボイス接続を切断
  if (voiceConnection) {
    voiceConnection.destroy();
  }

  // Discordクライアントを終了
  client.destroy();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n[Shutdown] Cleaning up...");

  // 全ユーザーの状態をクリーンアップ
  for (const userId of userStates.keys()) {
    cleanupUserState(userId);
  }

  // ボイス接続を切断
  if (voiceConnection) {
    voiceConnection.destroy();
  }

  // Discordクライアントを終了
  client.destroy();
  process.exit(0);
});

// メイン処理を非同期関数でラップ
(async () => {
  // libsodiumを初期化（音声接続の暗号化に必要）
  await sodium.ready;
  console.log("[Init] libsodium initialized");

  // Discordクライアントにログイン
  await client.login(DISCORD_BOT_TOKEN);
})().catch((error) => {
  console.error("Failed to start bot:", error);
  process.exit(1);
});
