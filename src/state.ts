import { Client, GatewayIntentBits, type TextChannel, type ThreadChannel } from "discord.js";
import type { VoiceConnection } from "@discordjs/voice";
import type { UserTranscriptionState } from "./types";

// Discordクライアント
export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates, // ボイスチャンネルの状態変更を監視するために必要
  ],
});

// ユーザーごとの音声認識状態
export const userStates = new Map<string, UserTranscriptionState>();

// ログチャンネルをキャッシュ（起動時に一度だけフェッチ）
let _cachedLogChannel: TextChannel | null = null;

export function getCachedLogChannel(): TextChannel | null {
  return _cachedLogChannel;
}

export function setCachedLogChannel(channel: TextChannel | null): void {
  _cachedLogChannel = channel;
}

// ボイス接続
let _voiceConnection: VoiceConnection | null = null;

export function getVoiceConnection(): VoiceConnection | null {
  return _voiceConnection;
}

export function setVoiceConnection(connection: VoiceConnection | null): void {
  _voiceConnection = connection;
}

// アクティブなスレッド（ボイスログ用）
let _activeThread: ThreadChannel | null = null;

export function getActiveThread(): ThreadChannel | null {
  return _activeThread;
}

export function setActiveThread(thread: ThreadChannel | null): void {
  _activeThread = thread;
}
