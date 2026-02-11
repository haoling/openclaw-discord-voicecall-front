import { Client, GatewayIntentBits, TextChannel } from "discord.js";
import {
  joinVoiceChannel,
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  type VoiceConnection,
} from "@discordjs/voice";
import { createListenStream } from "@deepgram/sdk";
import { pipeline } from "stream";
import * as prism from "prism-media";

// 環境変数の読み込み
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_LOG_CHANNEL_ID = process.env.DISCORD_LOG_CHANNEL_ID;
const DISCORD_VOICE_CHANNEL_ID = process.env.DISCORD_VOICE_CHANNEL_ID;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

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
  deepgramStream: any;
  lastAudioTime: number;
  silenceTimer: NodeJS.Timeout | null;
  currentTranscript: string;
  isSpeaking: boolean;
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
  const { createClient } = require("@deepgram/sdk");
  const deepgram = createClient(DEEPGRAM_API_KEY);

  const dgConnection = deepgram.listen.live({
    model: "flux",
    language: "ja",
    encoding: "linear16",
    sample_rate: 48000,
    channels: 2,
    interim_results: false, // 最終結果のみ取得
    endpointing: false, // 手動でエンドポイントを制御
  });

  dgConnection.on("open", () => {
    console.log(`[Deepgram] Connection opened for ${username}`);
  });

  dgConnection.on("Results", (data: any) => {
    const transcript = data.channel?.alternatives?.[0]?.transcript;
    if (transcript && transcript.trim()) {
      const state = userStates.get(userId);
      if (state) {
        // 文字起こし結果を累積
        state.currentTranscript += transcript + " ";
      }
    }
  });

  dgConnection.on("error", (error: any) => {
    console.error(`[Deepgram] Error for ${username}:`, error);
  });

  dgConnection.on("close", () => {
    console.log(`[Deepgram] Connection closed for ${username}`);
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

  // 新しいタイマーを設定（1秒の無音で発話終了）
  state.silenceTimer = setTimeout(() => {
    if (state.currentTranscript.trim()) {
      // 文字起こし結果を送信
      sendTranscriptionToChannel(state.username, state.currentTranscript.trim());
      state.currentTranscript = "";
    }
    state.isSpeaking = false;
  }, 1000);
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

  opusDecoder.on("data", (pcmData: Buffer) => {
    state.lastAudioTime = Date.now();
    state.isSpeaking = true;

    // Deepgramに音声データを送信
    if (deepgramStream.getReadyState() === 1) {
      deepgramStream.send(pcmData);
    }

    // 無音タイマーをリセット
    resetSilenceTimer(userId);
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
    const channel = await client.channels.fetch(DISCORD_VOICE_CHANNEL_ID);
    if (!channel || !channel.isVoiceBased()) {
      throw new Error("Invalid voice channel");
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator as any,
      selfDeaf: false,
      selfMute: true,
    });

    // 接続が確立されるまで待機
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    console.log(`[Voice] Connected to voice channel: ${channel.name}`);

    voiceConnection = connection;

    // 音声受信を開始
    const receiver = connection.receiver;

    receiver.speaking.on("start", (userId) => {
      // ユーザーが話し始めたら音声ストリームをリッスン
      const user = client.users.cache.get(userId);
      if (!user || user.bot) return; // ボットの音声は無視

      const username = user.username;

      // 既にリスニング中でなければ開始
      if (!userStates.has(userId)) {
        const audioStream = receiver.subscribe(userId, {
          end: {
            behavior: EndBehaviorType.Manual,
          },
        });
        listenToUser(userId, username, audioStream);
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

client.login(DISCORD_BOT_TOKEN).catch((error) => {
  console.error("Failed to log in:", error);
  process.exit(1);
});
