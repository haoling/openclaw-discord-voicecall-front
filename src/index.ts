import { Client, GatewayIntentBits, TextChannel } from "discord.js";

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_LOG_CHANNEL_ID = process.env.DISCORD_LOG_CHANNEL_ID;

if (!DISCORD_BOT_TOKEN) {
  console.error("Error: DISCORD_BOT_TOKEN is not set");
  process.exit(1);
}

if (!DISCORD_LOG_CHANNEL_ID) {
  console.error("Error: DISCORD_LOG_CHANNEL_ID is not set");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates, // ボイスチャンネルの状態変更を監視するために必要
  ],
});

// ログチャンネルをキャッシュ（起動時に一度だけフェッチ）
let cachedLogChannel: TextChannel | null = null;

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
    }
    // ボイスチャンネル間を移動した場合
    else if (oldState.channel && newState.channel && oldState.channel.id !== newState.channel.id) {
      message = `🔀 **ボイスチャンネル移動** — ${timestamp}\n👤 **ユーザー:** ${member.user.tag}\n📤 **移動元:** ${oldState.channel.name}\n📥 **移動先:** ${newState.channel.name}`;
      consoleLog = `${member.user.tag} moved from ${oldState.channel.name} to ${newState.channel.name}`;
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

client.login(DISCORD_BOT_TOKEN).catch((error) => {
  console.error("Failed to log in:", error);
  process.exit(1);
});
