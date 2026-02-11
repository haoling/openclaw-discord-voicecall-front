import * as sodium from "libsodium-wrappers";
import { config } from "./config";
import { client, userStates, getVoiceConnection } from "./state";
import { cleanupUserState } from "./audio";
import { registerEventHandlers } from "./events";

// イベントハンドラを登録
registerEventHandlers();

// プロセス終了時のクリーンアップ
// グレースフルシャットダウン処理
function performGracefulShutdown() {
  console.log("\n[Shutdown] Cleaning up...");

  // 全ユーザーの状態をクリーンアップ
  for (const userId of userStates.keys()) {
    cleanupUserState(userId);
  }

  // ボイス接続を切断
  const voiceConnection = getVoiceConnection();
  if (voiceConnection) {
    voiceConnection.destroy();
  }

  // Discordクライアントを終了
  client.destroy();
  process.exit(0);
}

process.on("SIGINT", performGracefulShutdown);

process.on("SIGTERM", performGracefulShutdown);

// メイン処理を非同期関数でラップ
(async () => {
  // libsodiumを初期化（音声接続の暗号化に必要）
  await sodium.ready;
  console.log("[Init] libsodium initialized");

  // Discordクライアントにログイン
  await client.login(config.DISCORD_BOT_TOKEN);
})().catch((error) => {
  console.error("Failed to start bot:", error);
  process.exit(1);
});
