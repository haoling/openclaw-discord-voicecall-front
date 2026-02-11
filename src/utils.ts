import { getCachedLogChannel } from "./state";

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
  } catch (error) {
    console.error("Error sending transcription:", error);
  }
}
