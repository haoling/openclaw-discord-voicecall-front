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
  intents: [GatewayIntentBits.Guilds],
});

client.once("ready", async () => {
  console.log(`Logged in as ${client.user?.tag}`);

  try {
    const channel = await client.channels.fetch(DISCORD_LOG_CHANNEL_ID);

    if (!channel) {
      throw new Error(`Channel not found: ${DISCORD_LOG_CHANNEL_ID}`);
    }

    if (!channel.isTextBased()) {
      throw new Error(`Channel is not a text channel: ${DISCORD_LOG_CHANNEL_ID}`);
    }

    const now = new Date();
    const timestamp = now.toLocaleString("ja-JP", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    const message = `🤖 Bot起動確認 — ${timestamp}\nDiscord Voice Bot が正常に起動しました。`;

    await channel.send(message);
    console.log(`Message sent to #${channel.name}`);
  } catch (error) {
    console.error("An error occurred during startup:", error);
    process.exitCode = 1;
  } finally {
    client.destroy();
    console.log("Bot disconnected. Done.");
  }
});

client.login(DISCORD_BOT_TOKEN).catch((error) => {
  console.error("Failed to log in:", error);
  process.exit(1);
});
