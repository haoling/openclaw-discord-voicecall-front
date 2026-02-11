import { TextChannel } from "discord.js";
import { config } from "./config";
import { client, setCachedLogChannel, getCachedLogChannel } from "./state";
import { getJapaneseTimestamp } from "./utils";
import { connectToVoiceChannel } from "./voice";
import { cleanupUserState } from "./audio";

/**
 * Discordイベントハンドラを登録
 */
export function registerEventHandlers() {
  client.once("ready", async () => {
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
}
