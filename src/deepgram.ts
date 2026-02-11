import { config } from "./config";
import { userStates } from "./state";
import { sendTranscriptionToChannel } from "./utils";

/**
 * Deepgramストリームを作成
 */
export function createDeepgramStream(userId: string, username: string) {
  console.log(`[Deepgram] Creating stream for ${username}`);
  console.log(
    `[Deepgram] API Key check: ${config.DEEPGRAM_API_KEY ? `${config.DEEPGRAM_API_KEY.substring(0, 8)}...` : "NOT SET"}`
  );
  console.log(`[Deepgram] Deepgram VAD enabled: ${config.ENABLE_DEEPGRAM_VAD}`);

  const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
  const deepgram = createClient(config.DEEPGRAM_API_KEY);

  console.log(`[Deepgram] Client created, establishing live connection...`);

  const dgConnection = deepgram.listen.live({
    model: "nova-3",
    language: "ja",
    encoding: "linear16",
    sample_rate: 48000,
    channels: 2,
    interim_results: true, // 中間結果も取得（より早く応答を得る）
    utterance_end_ms: 1500, // この値をconfigから取得するように変更
    vad_events: config.ENABLE_DEEPGRAM_VAD, // Deepgram側のVADイベント（環境変数で制御）
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
    if (config.VERBOSE) {
      console.log(`[VERBOSE] ${username} | Deepgram接続完了、文字起こし開始可能`);
    }

    // 接続が成功したら再接続カウンターをリセット
    const state = userStates.get(userId);
    if (state) {
      state.reconnectAttempts = 0;
      state.lastKeepAliveTime = Date.now(); // キープアライブタイムスタンプを更新
    }

    // Openイベント内でTranscript, Error, Closeイベントを登録
    dgConnection.on(LiveTranscriptionEvents.Transcript, (data: any) => {
      const transcript = data.channel?.alternatives?.[0]?.transcript;
      const isFinal = data.is_final;
      const speechFinal = data.speech_final;

      if (config.VERBOSE) {
        console.log(
          `[VERBOSE] ${username} | Deepgramからの応答 (is_final: ${isFinal}, speech_final: ${speechFinal}):`,
          transcript || "(空)"
        );
      }

      const state = userStates.get(userId);

      // speech_finalの状態を記録
      if (state && speechFinal !== undefined) {
        state.lastSpeechFinal = speechFinal;
        if (config.VERBOSE) {
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

          // speech_finalがtrueの場合、タイマーを設定して音声データの有無で判断
          if (speechFinal && state.currentTranscript.trim()) {
            // 既存のタイマーをクリア（もしあれば）
            if (state.finalTranscriptTimer) {
              clearTimeout(state.finalTranscriptTimer);
              state.finalTranscriptTimer = null;
            }

            const currentAudioDataTime = state.lastAudioDataTime;

            if (config.VERBOSE) {
              console.log(
                `[VERBOSE] ${username} | speech_final検出 - ` +
                `${config.BASE_SILENCE_TIME}ms後に音声データの有無をチェック`
              );
            }

            // BASE_SILENCE_TIME後に音声データが来ていなければログ送信
            state.finalTranscriptTimer = setTimeout(() => {
              const timeSinceAudioData = Date.now() - state.lastAudioDataTime;

              if (config.VERBOSE) {
                console.log(
                  `[VERBOSE] ${username} | タイマー発火 - ` +
                  `最後の音声データから${timeSinceAudioData}ms経過`
                );
              }

              // タイマー設定時点から新しい音声データが来ていなければ送信
              if (state.lastAudioDataTime === currentAudioDataTime) {
                if (state.currentTranscript.trim()) {
                  if (config.VERBOSE) {
                    console.log(
                      `[VERBOSE] ${username} | 音声データなし → ログ送信: "${state.currentTranscript.trim()}"`
                    );
                  }
                  sendTranscriptionToChannel(state.username, state.currentTranscript.trim());
                  state.currentTranscript = "";
                }
                state.isSpeaking = false;
                state.isSendingToDeepgram = false;
              } else {
                // 新しい音声データが来ている場合はスキップ
                if (config.VERBOSE) {
                  console.log(
                    `[VERBOSE] ${username} | 新しい音声データあり - ログ送信をスキップ`
                  );
                }
              }

              state.finalTranscriptTimer = null;
            }, config.BASE_SILENCE_TIME);
          }
        }
      } else if (config.VERBOSE && transcript && transcript.trim()) {
        console.log(
          `[VERBOSE] ${username} | 中間結果（無視）: "${transcript}"`
        );
      } else if (config.VERBOSE && !transcript) {
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
        (event?.code === 1011 || event?.code === 1006)
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
