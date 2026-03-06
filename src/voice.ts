import {
  joinVoiceChannel,
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
} from "@discordjs/voice";
import { config } from "./config";
import { client, userStates, getCachedLogChannel, setVoiceConnection, getVoiceConnection, getActiveThread } from "./state";
import { getJapaneseTimestamp, sendToThreadOrChannel, playWelcomeMessage } from "./utils";
import { listenToUser, cleanupUserState } from "./audio";

// ボイスチャンネルへの接続試行中かどうかのフラグ
let _isConnecting = false;
// connectToVoiceChannelInternal() の重複実行ガード
let _internalActive = false;

/**
 * ボイスチャンネルへの接続試行中かどうかを返す
 */
export function getIsConnecting(): boolean {
  return _isConnecting;
}

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
  // 二重実行ガード（_isConnecting が何らかの理由でバイパスされた場合のフォールバック）
  if (_internalActive) {
    console.log("[Voice] connectToVoiceChannelInternal: 重複呼び出しをスキップ (_internalActive=true)");
    return;
  }
  _internalActive = true;

  try {
  console.log(`[Voice] Fetching voice channel: ${config.DISCORD_VOICE_CHANNEL_ID}`);
  const channel = await client.channels.fetch(config.DISCORD_VOICE_CHANNEL_ID);
  if (!channel || !channel.isVoiceBased()) {
    throw new Error("Invalid voice channel");
  }

  console.log(`[Voice] Joining voice channel: ${channel.name}`);

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true,
  });

  // joinVoiceChannel() 直後に登録することで、接続試行中も getVoiceConnection() が非nullを返し、
  // 重複接続試行を防ぐ（Destroyed イベントで null にリセットされる）
  setVoiceConnection(connection);

  // 既存のリスナーを削除してから登録（joinVoiceChannel()が既存の接続を返した場合の重複リスナーを防ぐ）
  connection.removeAllListeners("stateChange");
  // 接続前からすべての状態遷移を追跡
  connection.on("stateChange", (oldState, newState) => {
    console.log(`[Voice] State: ${oldState.status} → ${newState.status}`);
    if (config.VERBOSE) {
      console.log(`[VERBOSE] Voice connection state details:`, {
        old: oldState,
        new: newState,
      });
    }
  });

  console.log(
    `[Voice] Waiting for connection to be ready (timeout: 60s)...`
  );
  console.log(
    `[Voice] Current state: ${connection.state.status}`
  );

  try {
    // 接続が確立されるまで待機
    await entersState(connection, VoiceConnectionStatus.Ready, 60_000);
  } catch (error) {
    // タイムアウトまたはエラー発生時は古い接続を破棄する
    // （破棄しないと次のリトライで @discordjs/voice が同じ停滞した接続を再利用してしまう）
    // Destroyed イベントハンドラが setVoiceConnection(null) を呼ぶ
    const currentStatus = connection.state.status;
    console.log(`[Voice] 接続失敗 (状態: ${currentStatus})、停滞した接続を破棄します`);
    if (currentStatus !== VoiceConnectionStatus.Destroyed) {
      connection.destroy();
    }
    throw error;
  }
  console.log(`[Voice] ✓ Connected to voice channel: ${channel.name}`);

  // ウェルカムメッセージをTTSで再生（文字起こし開始前）
  await playWelcomeMessage();

  // 音声受信を開始
  const receiver = connection.receiver;

  console.log(`[Voice] Voice receiver initialized, waiting for users to speak...`);

  // 重複リスナーを防ぐため既存リスナーを削除してから登録
  receiver.speaking.removeAllListeners("start");
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

  // 重複リスナーを防ぐため既存リスナーを削除してから登録
  connection.removeAllListeners(VoiceConnectionStatus.Disconnected);
  connection.removeAllListeners(VoiceConnectionStatus.Destroyed);

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
  } finally {
    _internalActive = false;
  }
}

/**
 * ボイスチャンネルに接続（再試行あり）
 */
export async function connectToVoiceChannel() {
  if (_isConnecting) {
    console.log("[Voice] 既に接続試行中のため、スキップします");
    return;
  }

  _isConnecting = true;
  const retryDelay = 5000; // 5秒
  let attempt = 0;

  try {
    while (true) {
      attempt++;
      try {
        console.log(`[Voice] Connection attempt ${attempt} (pid: ${process.pid})`);
        await connectToVoiceChannelInternal();
        return; // 接続成功
      } catch (error) {
        console.error(`[Voice] Connection attempt ${attempt} failed:`, error);
        console.log(`[Voice] Retrying in ${retryDelay / 1000} seconds...`);
        await sleep(retryDelay);
      }
    }
  } finally {
    _isConnecting = false;
  }
}

/**
 * ボイスチャンネルから切断する
 */
export function disconnectFromVoiceChannel(): void {
  const connection = getVoiceConnection();
  if (!connection) {
    console.log("[Voice] 切断する接続がありません");
    return;
  }

  console.log("[Voice] ボイスチャンネルから切断します（チャンネルが空になりました）");
  connection.destroy();
}
