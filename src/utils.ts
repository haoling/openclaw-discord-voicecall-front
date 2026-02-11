import { getCachedLogChannel, getVoiceConnection, getActiveThread, setActiveThread } from "./state";
import { config } from "./config";
import {
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
} from "@discordjs/voice";
import * as path from "path";
import * as fs from "fs";
import { pipeline } from "stream/promises";
import { createWriteStream } from "fs";
import { tmpdir } from "os";

/**
 * OpenAI chat completion互換APIのレスポンス型
 */
type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

/**
 * 日本時間のタイムスタンプを生成するヘルパー関数
 */
export function getJapaneseTimestamp(): string {
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
 * スレッドまたはログチャンネルにメッセージを送信（エラーハンドリング付き）
 */
export async function sendToThreadOrChannel(message: string): Promise<void> {
  const cachedLogChannel = getCachedLogChannel();
  if (!cachedLogChannel) {
    console.error("Log channel not available");
    return;
  }

  const activeThread = getActiveThread();
  if (activeThread) {
    try {
      await activeThread.send(message);
    } catch (error) {
      console.error("Failed to send to thread, falling back to channel:", error);
      // スレッド送信失敗時はログチャンネルにフォールバック
      await cachedLogChannel.send(message);
      // スレッドが無効なのでクリア
      setActiveThread(null);
    }
  } else {
    await cachedLogChannel.send(message);
  }
}

/**
 * ボイスチャンネルに効果音を再生
 *
 * 注意: この機能を使用するには、実行環境にFFmpegがインストールされている必要があります。
 * MP3形式のファイルを再生する場合、Discord.jsはFFmpegを使用して音声をデコードします。
 *
 * もしFFmpegがインストールできない環境の場合、以下のコマンドでOgg Opus形式に変換できます：
 * ```bash
 * ffmpeg -i assets/sounds/pin1.mp3 -c:a libopus -b:a 96k assets/sounds/pin1.ogg
 * ```
 * その後、soundFilePathを変更してください。
 */
async function playSoundEffect(soundFilePath: string): Promise<void> {
  const connection = getVoiceConnection();

  // ボイス接続がない、または接続が確立されていない場合はスキップ
  if (!connection || connection.state.status !== VoiceConnectionStatus.Ready) {
    if (config.VERBOSE) {
      console.log("[Sound] ボイス接続が確立されていないため、効果音の再生をスキップします");
    }
    return;
  }

  // 音声ファイルの存在確認
  if (!fs.existsSync(soundFilePath)) {
    console.error(`[Sound] 効果音ファイルが見つかりません: ${soundFilePath}`);
    return;
  }

  const audioPlayer = createAudioPlayer();
  const subscription = connection.subscribe(audioPlayer);

  audioPlayer.on("error", (error) => {
    console.error("[Sound] 効果音の再生中にエラーが発生しました:", error);
  });

  try {
    const resource = createAudioResource(soundFilePath);
    audioPlayer.play(resource);

    if (config.VERBOSE) {
      console.log(`[Sound] 効果音を再生中: ${soundFilePath}`);
    }

    await entersState(audioPlayer, AudioPlayerStatus.Idle, 5_000);
    if (config.VERBOSE) {
      console.log("[Sound] 効果音の再生が完了しました");
    }
  } catch (error) {
    if (config.VERBOSE) {
      console.log("[Sound] 効果音の再生がタイムアウトまたは失敗しました");
    }
    console.error("[Sound] 効果音の再生処理でエラー:", error);
  } finally {
    subscription?.unsubscribe();
    audioPlayer.stop();
  }
}

/**
 * OpenAI互換のTTS APIを呼び出して音声データを取得
 *
 * @param text 音声合成するテキスト
 * @returns 音声ファイルのパス（一時ファイル）、エラー時はnull
 */
async function callTTSAPI(text: string): Promise<string | null> {
  // TTS設定が不完全な場合はスキップ
  if (!config.TTS_ENDPOINT_URL || !config.TTS_MODEL || !config.TTS_VOICE) {
    if (config.VERBOSE) {
      console.log("[TTS] TTS endpoint, model, or voice not configured, skipping TTS");
    }
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30秒タイムアウト

  try {
    if (config.VERBOSE) {
      console.log(`[TTS] Calling TTS API with model: ${config.TTS_MODEL}, voice: ${config.TTS_VOICE}, speed: ${config.TTS_SPEED}`);
    }

    const response = await fetch(config.TTS_ENDPOINT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.TTS_MODEL,
        voice: config.TTS_VOICE,
        input: text,
        speed: config.TTS_SPEED,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.error(`[TTS] TTS API request failed with status ${response.status}`);
      return null;
    }

    // 音声データを一時ファイルに保存
    const tempFilePath = path.join(tmpdir(), `tts-${Date.now()}.mp3`);
    const fileStream = createWriteStream(tempFilePath);

    if (!response.body) {
      console.error("[TTS] No response body from TTS API");
      return null;
    }

    // Node.js Readable streamに変換して保存
    await pipeline(response.body, fileStream);

    if (config.VERBOSE) {
      console.log(`[TTS] Audio saved to: ${tempFilePath}`);
    }

    return tempFilePath;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      console.error("[TTS] TTS request timed out after 30 seconds");
    } else {
      console.error("[TTS] Error calling TTS API:", error);
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * TTS音声をボイスチャンネルで再生
 *
 * @param audioFilePath 再生する音声ファイルのパス
 */
async function playTTSAudio(audioFilePath: string): Promise<void> {
  const connection = getVoiceConnection();

  if (!connection || connection.state.status !== VoiceConnectionStatus.Ready) {
    if (config.VERBOSE) {
      console.log("[TTS] ボイス接続が確立されていないため、TTS音声の再生をスキップします");
    }
    // 一時ファイルを削除
    try {
      fs.unlinkSync(audioFilePath);
    } catch (error) {
      console.error("[TTS] Failed to delete temp audio file:", error);
    }
    return;
  }

  const audioPlayer = createAudioPlayer();
  const subscription = connection.subscribe(audioPlayer);

  audioPlayer.on("error", (error) => {
    console.error("[TTS] TTS音声の再生中にエラーが発生しました:", error);
  });

  try {
    const resource = createAudioResource(audioFilePath);
    audioPlayer.play(resource);

    if (config.VERBOSE) {
      console.log(`[TTS] TTS音声を再生中: ${audioFilePath}`);
    }

    // 再生完了を待機（最大60秒）
    await entersState(audioPlayer, AudioPlayerStatus.Idle, 60_000);

    if (config.VERBOSE) {
      console.log("[TTS] TTS音声の再生が完了しました");
    }
  } catch (error) {
    if (config.VERBOSE) {
      console.log("[TTS] TTS音声の再生がタイムアウトまたは失敗しました");
    }
    console.error("[TTS] TTS音声の再生処理でエラー:", error);
  } finally {
    subscription?.unsubscribe();
    audioPlayer.stop();

    // 一時ファイルを削除
    try {
      fs.unlinkSync(audioFilePath);
      if (config.VERBOSE) {
        console.log(`[TTS] 一時ファイルを削除: ${audioFilePath}`);
      }
    } catch (error) {
      console.error("[TTS] Failed to delete temp audio file:", error);
    }
  }
}

/**
 * OpenAI chat completion互換エンドポイントにリクエストを送信
 */
async function sendChatCompletionRequest(
  transcript: string
): Promise<string | null> {
  // エンドポイントURLとAPIキーが設定されていない場合はスキップ
  if (!config.CHAT_COMPLETION_ENDPOINT_URL || !config.CHAT_COMPLETION_APIKEY) {
    if (config.VERBOSE) {
      console.log(
        "[LLM] Chat completion endpoint or API key not configured, skipping LLM processing"
      );
    }
    return null;
  }

  // タイムアウト設定（60秒）
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);

  try {
    // VERBOSEモードの場合、セッションキーをログ出力
    if (config.VERBOSE) {
      console.log(
        `[LLM] Sending request with session key: ${config.CHAT_COMPLETION_SESSION_KEY}`
      );
      console.log(`[LLM] Using model: ${config.CHAT_COMPLETION_MODEL}`);
    }

    const response = await fetch(config.CHAT_COMPLETION_ENDPOINT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.CHAT_COMPLETION_APIKEY}`,
        "x-openclaw-session-key": config.CHAT_COMPLETION_SESSION_KEY,
      },
      body: JSON.stringify({
        model: config.CHAT_COMPLETION_MODEL,
        messages: [
          {
            role: "user",
            content: transcript,
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.error(
        `[LLM] Chat completion request failed with status ${response.status}`
      );
      return null;
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const llmResponse = data.choices?.[0]?.message?.content;

    if (!llmResponse) {
      console.error("[LLM] No content in chat completion response");
      return null;
    }

    return llmResponse;
  } catch (error) {
    // タイムアウトエラーの場合、ログチャンネルに記録
    if (error instanceof Error && error.name === "AbortError") {
      console.error("[LLM] Request timed out after 60 seconds");
      const timestamp = getJapaneseTimestamp();
      const timeoutMessage = `⚠️ **LLMタイムアウト** — ${timestamp}\nLLMからの応答が60秒以内に得られませんでした。`;
      sendToThreadOrChannel(timeoutMessage).catch((sendError) =>
        console.error(
          "[LLM] Failed to send timeout message to channel:",
          sendError
        )
      );
    } else {
      console.error("[LLM] Error sending chat completion request:", error);
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * ボイスログチャンネルに文字起こしを投稿
 */
export async function sendTranscriptionToChannel(
  username: string,
  transcript: string
) {
  const cachedLogChannel = getCachedLogChannel();
  if (!cachedLogChannel || !transcript.trim()) return;

  try {
    const timestamp = getJapaneseTimestamp();
    const message = `💬 **${username}** — ${timestamp}\n${transcript}`;
    await sendToThreadOrChannel(message);
    console.log(`[Transcription] ${username}: ${transcript}`);

    // LLMに文字起こし結果を送信して処理（非同期で並行実行）
    (async () => {
      try {
        // LLMに送信する前に効果音を再生
        const soundPath = path.isAbsolute(config.SOUND_EFFECT_PATH)
          ? config.SOUND_EFFECT_PATH
          : path.join(__dirname, "..", config.SOUND_EFFECT_PATH);
        await playSoundEffect(soundPath);

        const llmResponse = await sendChatCompletionRequest(transcript);
        if (llmResponse) {
          const llmTimestamp = getJapaneseTimestamp();
          const llmMessage = `🤖 **LLM応答** — ${llmTimestamp}\n${llmResponse}`;

          // ログチャンネルまたはアクティブなスレッドに投稿（これは待機する）
          await sendToThreadOrChannel(llmMessage);

          // TTS音声再生は非同期で実行（待機しない）
          (async () => {
            const audioFilePath = await callTTSAPI(llmResponse);
            if (audioFilePath) {
              await playTTSAudio(audioFilePath);
            }
          })().catch((error) => {
            console.error("[TTS] Error in TTS playback:", error);
          });

          if (config.VERBOSE) {
            console.log(`[LLM] Response sent to channel for: ${transcript}`);
          }
        }
      } catch (error) {
        console.error("[LLM] Error processing and sending LLM response:", error);
        // ログチャンネルにエラーを通知
        try {
          const timestamp = getJapaneseTimestamp();
          const errorMessage = `❌ **LLMエラー** — ${timestamp}\nLLM処理中にエラーが発生しました: ${error instanceof Error ? error.message : String(error)}`;
          await sendToThreadOrChannel(errorMessage);
        } catch (sendError) {
          console.error(
            "[LLM] Failed to send error message to channel:",
            sendError
          );
        }
      }
    })();
  } catch (error) {
    console.error("Error sending transcription:", error);
  }
}
