import { getCachedLogChannel } from "./state";
import { config } from "./config";

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
