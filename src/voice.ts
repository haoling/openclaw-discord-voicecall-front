import {
  joinVoiceChannel,
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  type DiscordGatewayAdapterCreator,
} from "@discordjs/voice";
import { config } from "./config";
import { client, userStates, getCachedLogChannel, setVoiceConnection, getActiveThread } from "./state";
import { getJapaneseTimestamp, sendToThreadOrChannel } from "./utils";
import { listenToUser, cleanupUserState } from "./audio";

/**
 * 指定されたミリ秒だけ待機
 */
async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * ボイスチャンネルに接続（再試行なし）
 */
async function connectToVoiceChannelInternal() {
  console.log(`[Voice] Fetching voice channel: ${config.DISCORD_VOICE_CHANNEL_ID}`);
  const channel = await client.channels.fetch(config.DISCORD_VOICE_CHANNEL_ID);
  if (!channel || !channel.isVoiceBased()) {
    throw new Error("Invalid voice channel");
  }

  console.log(`[Voice] Joining voice channel: ${channel.name}`);
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator as DiscordGatewayAdapterCreator,
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

  setVoiceConnection(connection);

  // 接続状態の変化をログ出力
  connection.on("stateChange", (oldState, newState) => {
    console.log(
      `[Voice] State change: ${oldState.status} -> ${newState.status}`
    );
    if (config.VERBOSE) {
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
      setVoiceConnection(null);
      // 全ユーザーの状態をクリーンアップ
      for (const userId of userStates.keys()) {
        cleanupUserState(userId);
      }
      console.log("[Voice] Connection destroyed");
    }
  });

  connection.on(VoiceConnectionStatus.Destroyed, () => {
    console.log("[Voice] Connection destroyed");
    setVoiceConnection(null);
    // 全ユーザーの状態をクリーンアップ
    for (const userId of userStates.keys()) {
      cleanupUserState(userId);
    }
  });

  await sendToThreadOrChannel(
    `🎙️ ボイスチャンネル接続 — ${getJapaneseTimestamp()}\nボットがボイスチャンネルに接続し、音声認識を開始しました。`
  );
}

/**
 * ボイスチャンネルに接続（再試行あり）
 */
export async function connectToVoiceChannel() {
  const maxRetries = 3;
  const baseDelay = 5000; // 5秒

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[Voice] Connection attempt ${attempt}/${maxRetries}`);
      await connectToVoiceChannelInternal();
      return; // 接続成功
    } catch (error) {
      console.error(`[Voice] Connection attempt ${attempt}/${maxRetries} failed:`, error);

      if (attempt < maxRetries) {
        // 指数バックオフで待機時間を計算（5秒、10秒、20秒）
        const delay = baseDelay * Math.pow(2, attempt - 1);
        console.log(`[Voice] Retrying in ${delay / 1000} seconds...`);
        await sleep(delay);
      } else {
        console.error(`[Voice] All ${maxRetries} connection attempts failed. Giving up.`);
      }
    }
  }
}
