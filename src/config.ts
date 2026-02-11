// 環境変数の読み込み
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN!;
const DISCORD_LOG_CHANNEL_ID = process.env.DISCORD_LOG_CHANNEL_ID!;
const DISCORD_VOICE_CHANNEL_ID = process.env.DISCORD_VOICE_CHANNEL_ID!;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY!;
const CHAT_COMPLETION_ENDPOINT_URL = process.env.CHAT_COMPLETION_ENDPOINT_URL || "";
const CHAT_COMPLETION_APIKEY = process.env.CHAT_COMPLETION_APIKEY || "";
const VERBOSE = process.env.VERBOSE === "true";
const ENABLE_DEEPGRAM_VAD = process.env.ENABLE_DEEPGRAM_VAD !== "false"; // デフォルトはtrue
const ENABLE_LOCAL_VAD = process.env.ENABLE_LOCAL_VAD !== "false"; // デフォルトはtrue
const BASE_SILENCE_TIME = parseInt(process.env.BASE_SILENCE_TIME || "1500", 10); // 無音判定の基準時間（環境変数で設定可能、デフォルト: 1500ms）
const VOLUME_THRESHOLD = parseInt(process.env.VOLUME_THRESHOLD || "150", 10); // 音量閾値（環境変数で設定可能、デフォルト: 150）
const AUDIO_BUFFER_SIZE = 30; // オーディオバッファサイズ（約600ms分、20msフレーム × 30）
const KEEP_ALIVE_INTERVAL = 5000; // Deepgramキープアライブ送信間隔（5秒）

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
console.log(
  `CHAT_COMPLETION_ENDPOINT_URL: ${CHAT_COMPLETION_ENDPOINT_URL ? CHAT_COMPLETION_ENDPOINT_URL : "未設定"}`
);
console.log(
  `CHAT_COMPLETION_APIKEY: ${CHAT_COMPLETION_APIKEY ? `${CHAT_COMPLETION_APIKEY.substring(0, 8)}...` : "未設定"}`
);
console.log("====================");

export const config = {
  DISCORD_BOT_TOKEN,
  DISCORD_LOG_CHANNEL_ID,
  DISCORD_VOICE_CHANNEL_ID,
  DEEPGRAM_API_KEY,
  CHAT_COMPLETION_ENDPOINT_URL,
  CHAT_COMPLETION_APIKEY,
  VERBOSE,
  ENABLE_DEEPGRAM_VAD,
  ENABLE_LOCAL_VAD,
  BASE_SILENCE_TIME,
  VOLUME_THRESHOLD,
  AUDIO_BUFFER_SIZE,
  KEEP_ALIVE_INTERVAL,
} as const;
