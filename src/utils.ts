import { getCachedLogChannel, getVoiceConnection } from "./state";
import { config } from "./config";
import {
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import * as path from "path";
import * as fs from "fs";

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
 * ボイスチャンネルに効果音を再生
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

  try {
    const audioPlayer = createAudioPlayer();
    const resource = createAudioResource(soundFilePath);

    audioPlayer.play(resource);
    connection.subscribe(audioPlayer);

    if (config.VERBOSE) {
      console.log(`[Sound] 効果音を再生中: ${soundFilePath}`);
    }

    // 再生完了を待機
    await new Promise<void>((resolve) => {
      audioPlayer.on(AudioPlayerStatus.Idle, () => {
        if (config.VERBOSE) {
          console.log("[Sound] 効果音の再生が完了しました");
        }
        resolve();
      });

      // エラーハンドリング
      audioPlayer.on("error", (error) => {
        console.error("[Sound] 効果音の再生中にエラーが発生しました:", error);
        resolve();
      });

      // タイムアウト設定（5秒）
      setTimeout(() => {
        if (config.VERBOSE) {
          console.log("[Sound] 効果音の再生がタイムアウトしました");
        }
        resolve();
      }, 5000);
    });
  } catch (error) {
    console.error("[Sound] 効果音の再生に失敗しました:", error);
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
      const cachedLogChannel = getCachedLogChannel();
      if (cachedLogChannel) {
        const timestamp = getJapaneseTimestamp();
        const timeoutMessage = `⚠️ **LLMタイムアウト** — ${timestamp}\nLLMからの応答が60秒以内に得られませんでした。`;
        cachedLogChannel
          .send(timeoutMessage)
          .catch((sendError) =>
            console.error(
              "[LLM] Failed to send timeout message to channel:",
              sendError
            )
          );
      }
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
    await cachedLogChannel.send(message);
    console.log(`[Transcription] ${username}: ${transcript}`);

    // LLMに文字起こし結果を送信して処理（非同期で並行実行）
    (async () => {
      try {
        // LLMに送信する前に効果音を再生
        const soundPath = path.join(__dirname, "..", "assets", "sounds", "pin1.mp3");
        await playSoundEffect(soundPath);

        const llmResponse = await sendChatCompletionRequest(transcript);
        if (llmResponse) {
          const llmTimestamp = getJapaneseTimestamp();
          const llmMessage = `🤖 **LLM応答** — ${llmTimestamp}\n${llmResponse}`;
          await cachedLogChannel.send(llmMessage);
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
          await cachedLogChannel.send(errorMessage);
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
