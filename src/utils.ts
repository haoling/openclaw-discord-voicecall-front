import { getCachedLogChannel } from "./state";
import { config } from "./config";

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
    });

    if (!response.ok) {
      console.error(
        `[LLM] Chat completion request failed with status ${response.status}`
      );
      return null;
    }

    const data = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string;
        };
      }>;
    };
    const llmResponse = data.choices?.[0]?.message?.content;

    if (!llmResponse) {
      console.error("[LLM] No content in chat completion response");
      return null;
    }

    return llmResponse;
  } catch (error) {
    console.error("[LLM] Error sending chat completion request:", error);
    return null;
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
    sendChatCompletionRequest(transcript)
      .then((llmResponse) => {
        if (llmResponse) {
          const llmTimestamp = getJapaneseTimestamp();
          const llmMessage = `🤖 **LLM応答** — ${llmTimestamp}\n${llmResponse}`;
          return cachedLogChannel.send(llmMessage);
        }
      })
      .then(() => {
        if (config.VERBOSE) {
          console.log(`[LLM] Response sent to channel for: ${transcript}`);
        }
      })
      .catch((error) => {
        console.error("[LLM] Error processing LLM response:", error);
      });
  } catch (error) {
    console.error("Error sending transcription:", error);
  }
}
