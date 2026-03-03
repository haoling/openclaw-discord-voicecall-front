import { TextChannel, ChannelType, Events } from "discord.js";
import { config } from "./config";
import { client, setCachedLogChannel, getCachedLogChannel, setActiveThread, getActiveThread, getVoiceConnection } from "./state";
import { getJapaneseTimestamp } from "./utils";
import { connectToVoiceChannel, getIsConnecting, disconnectFromVoiceChannel } from "./voice";
import { cleanupUserState } from "./audio";

/**
 * Discordイベントハンドラを登録
 */
export function registerEventHandlers() {
  client.once(Events.ClientReady, async () => {
    console.log(`Logged in as ${client.user?.tag}`);

    try {
      const channel = await client.channels.fetch(config.DISCORD_LOG_CHANNEL_ID);

      if (!channel) {
        throw new Error(`Channel not found: ${config.DISCORD_LOG_CHANNEL_ID}`);
      }

      if (!(channel instanceof TextChannel)) {
        throw new Error(`Channel is not a text channel: ${config.DISCORD_LOG_CHANNEL_ID}`);
      }

      // ログチャンネルをキャッシュに保存
      setCachedLogChannel(channel);

      const timestamp = getJapaneseTimestamp();
      const message = `🤖 Bot起動確認 — ${timestamp}\nDiscord Voice Bot が正常に起動しました。`;

      await channel.send(message);
      console.log(`Message sent to #${channel.name}`);
      console.log("Voice state monitoring started.");

      // 起動時、ボイスチャンネルに非BOTユーザーがいる場合のみ接続する
      const voiceChannel = await client.channels.fetch(config.DISCORD_VOICE_CHANNEL_ID);
      if (voiceChannel && voiceChannel.isVoiceBased()) {
        const nonBotCount = voiceChannel.members.filter(m => !m.user.bot).size;
        if (nonBotCount > 0) {
          console.log(`[Voice] 起動時にボイスチャンネルに${nonBotCount}人のユーザーがいます。接続します。`);
          await connectToVoiceChannel();
        } else {
          console.log("[Voice] 起動時にボイスチャンネルに誰もいないため、ユーザーが参加するまで待機します。");
        }
      } else {
        // フォールバック（チャンネル取得失敗時）
        await connectToVoiceChannel();
      }
    } catch (error) {
      console.error("An error occurred during startup:", error);
      process.exitCode = 1;
    }
  });

  // ボイスチャンネルの入退室を監視
  client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    try {
      // キャッシュされたログチャンネルを使用（毎回フェッチしない）
      const cachedLogChannel = getCachedLogChannel();
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
      let shouldClearThread = false; // メッセージ送信後にスレッドをクリアするかどうか

      // ボイスチャンネルに参加した場合
      if (!oldState.channel && newState.channel) {
        // 参加後の非BOTメンバー数を確認
        const afterCount = newState.channel.members.filter(m => !m.user.bot).size;

        // このユーザーが参加したことで非BOTメンバーが1人になり、かつアクティブなスレッドがない場合にスレッドを作成
        // これにより、複数人が同時に参加した場合の競合状態を防ぐ
        if (afterCount === 1 && !getActiveThread()) {
          const threadName = `ボイスログ ${timestamp}`;
          const thread = await cachedLogChannel.threads.create({
            name: threadName,
            autoArchiveDuration: config.THREAD_AUTO_ARCHIVE_DURATION, // 自動アーカイブ時間（分）
            type: ChannelType.PublicThread,
            reason: "ボイスチャンネルセッション開始"
          });
          setActiveThread(thread);
          console.log(`New thread created: ${threadName}`);
        }

        message = `🔊 **ボイスチャンネル参加** — ${timestamp}\n👤 **ユーザー:** ${member.user.tag}\n📢 **チャンネル:** ${newState.channel.name}`;
        consoleLog = `${member.user.tag} joined ${newState.channel.name}`;
      }
      // ボイスチャンネルから退出した場合
      else if (oldState.channel && !newState.channel) {
        message = `🔇 **ボイスチャンネル退出** — ${timestamp}\n👤 **ユーザー:** ${member.user.tag}\n📢 **チャンネル:** ${oldState.channel.name}`;
        consoleLog = `${member.user.tag} left ${oldState.channel.name}`;

        // ユーザーが退出したら、その音声認識状態をクリーンアップ
        cleanupUserState(member.user.id);

        // 退出後の非BOTメンバー数を確認
        const afterCount = oldState.channel.members.filter(m => !m.user.bot).size;

        // botしか居なくなった場合、メッセージ送信後にスレッドをクリアするフラグを立てる
        if (afterCount === 0) {
          shouldClearThread = true;
        }
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
        // アクティブなスレッドがあればそこに送信、なければログチャンネルに送信
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
        console.log(consoleLog);

        // 退出後にスレッドをクリアする必要がある場合
        if (shouldClearThread) {
          setActiveThread(null);
          console.log("Voice channel is now empty (only bots), thread cleared");
        }
      }

      // --- Botの自動参加・自動切断ロジック ---

      // 設定されたボイスチャンネルに非BOTユーザーが参加・移動してきた場合、botも参加する
      if (!member.user.bot && newState.channel && newState.channel.id === config.DISCORD_VOICE_CHANNEL_ID) {
        const currentConnection = getVoiceConnection();
        if (!currentConnection && !getIsConnecting()) {
          console.log("[Voice] ユーザーが対象ボイスチャンネルに参加したため、botも参加します");
          connectToVoiceChannel().catch(err =>
            console.error("[Voice] 自動参加に失敗:", err)
          );
        }
      }

      // 設定されたボイスチャンネルから非BOTユーザーが退出・移動した場合、チャンネルが空になればbotも切断する
      if (!member.user.bot && oldState.channel && oldState.channel.id === config.DISCORD_VOICE_CHANNEL_ID) {
        const remainingNonBotCount = oldState.channel.members.filter(m => !m.user.bot).size;
        if (remainingNonBotCount === 0) {
          const currentConnection = getVoiceConnection();
          if (currentConnection) {
            console.log("[Voice] ボイスチャンネルが空になったため、botを切断します");
            disconnectFromVoiceChannel();
          }
        }
      }
    } catch (error) {
      console.error("Error in voiceStateUpdate handler:", error);
    }
  });
}
