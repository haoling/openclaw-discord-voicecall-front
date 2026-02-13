# OpenClaw Discord Voice Call Bot

[日本語版 README はこちら](./README_JA.md)

## Overview

This is a Discord voice bot that enables real-time voice conversations with OpenClaw agents. It implements a STT (Speech-to-Text) → LLM → TTS pipeline, allowing users to interact with AI agents through Discord voice channels.

## Purpose

This bot connects to Discord voice channels, transcribes user speech in real-time using Deepgram's STT (Speech-to-Text) service, and logs the transcriptions to specified Discord channels/threads. The design includes integration with OpenClaw Gateway for LLM processing and TTS for voice responses.

## Features

### What This Bot Can Do

- ✅ Connect to Discord voice channels automatically
- ✅ Real-time speech transcription using Deepgram Flux
- ✅ Voice Activity Detection (VAD) to reduce transcription costs
- ✅ Conversation logging to Discord channels/threads with timestamps
- ✅ Japanese language support for transcription
- ✅ Automatic reconnection on connection failures
- ✅ Graceful shutdown handling

### What This Bot Cannot Do (Yet)

- ⚠️ **Limited LLM Integration**: While the design includes OpenClaw Gateway integration for LLM responses, this feature may be partially implemented
- ⚠️ **Limited TTS Integration**: Voice response functionality via TTS is designed but may require additional setup
- ⚠️ **No Multi-Language Support**: Currently optimized for Japanese transcription
- ⚠️ **Single Voice Channel**: Designed to connect to one voice channel at a time

## Requirements

### Environment

- Node.js 22 or higher
- npm or yarn
- FFmpeg (for audio processing)

### Required Credentials

1. **Discord Bot Token**
   - Create a bot at [Discord Developer Portal](https://discord.com/developers/applications)
   - Enable "Message Content Intent" and "Server Members Intent"
   - Invite bot to your server with voice permissions

2. **Deepgram API Key**
   - Sign up at [Deepgram](https://deepgram.com/)
   - Free tier includes $200 credit (~433 hours of transcription)

3. **Discord Channel IDs**
   - Voice Channel ID (where the bot connects)
   - Log Channel ID (where transcriptions are posted)

### Optional (For Full Features)

- **OpenClaw Gateway**: For LLM-powered responses
- **TTS Service**: OpenAI-compatible TTS endpoint for voice responses

## Technology Stack

- **Runtime**: Node.js 22
- **Language**: TypeScript
- **Discord**: discord.js v14, @discordjs/voice
- **Speech-to-Text**: Deepgram SDK (Flux model)
- **Audio Processing**: FFmpeg, Opus, prism-media
- **Encryption**: libsodium-wrappers
- **LLM Integration** (optional): OpenAI SDK → OpenClaw Gateway
- **Container** (optional): Docker, Docker Compose

## Installation

### 1. Clone Repository

```bash
git clone https://github.com/haoling/openclaw-discord-voicecall-front.git
cd openclaw-discord-voicecall-front
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment Variables

Copy the example environment file and fill in your credentials:

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
DISCORD_BOT_TOKEN=your_discord_bot_token
DISCORD_LOG_CHANNEL_ID=your_log_channel_id
DISCORD_VOICE_CHANNEL_ID=your_voice_channel_id
DEEPGRAM_API_KEY=your_deepgram_api_key

# Optional: OpenClaw Gateway integration
# CHAT_COMPLETION_ENDPOINT_URL=https://api.openai.com/v1/chat/completions
# CHAT_COMPLETION_APIKEY=your_api_key
# CHAT_COMPLETION_MODEL=gpt-4

# Optional: TTS integration
# TTS_ENDPOINT_URL=https://api.openai.com/v1/audio/speech
# TTS_MODEL=tts-1
# TTS_VOICE=alloy
# TTS_SPEED=1.0

# Optional: Volume threshold for VAD (default: 150)
# VOLUME_THRESHOLD=150

# Optional: Silence detection time (default: 1500ms)
# BASE_SILENCE_TIME=1500
```

### 4. Build

```bash
npm run build
```

### 5. Run

**Development mode with hot reload:**
```bash
npm run dev
```

**Production mode:**
```bash
npm run build
npm start
```

## Docker Deployment

### Using Docker Compose (Recommended)

```bash
# Edit .env file first
docker-compose up -d
```

### Manual Docker Build

```bash
docker build -t openclaw-voice-bot .
docker run -d --env-file .env openclaw-voice-bot
```

## Usage

1. **Start the Bot**: Run `npm run dev` or `npm start`
2. **Join Voice Channel**: The bot automatically connects to the configured voice channel
3. **Start Speaking**: When you speak in the voice channel, the bot transcribes your speech
4. **View Logs**: Transcriptions appear in the configured log channel

## Important Disclaimer

⚠️ **This bot is NOT fully debugged and is under active development.**

- **Use at Your Own Risk**: This software may contain bugs, incomplete features, or unexpected behavior
- **No Warranty**: This project is provided "as-is" without any warranties or guarantees
- **Development Status**: Features described in design documents may not be fully implemented
- **Breaking Changes**: The API and configuration may change without notice
- **Production Use**: NOT recommended for production environments without thorough testing

### Known Limitations

- Some features from the design specification may be incomplete or missing
- Error handling may not cover all edge cases
- Performance has not been optimized for high-load scenarios
- Documentation may be incomplete or outdated

## Architecture

```
Discord Voice Channel (Audio Input)
    ↓
@discordjs/voice (Audio Reception)
    ↓
Voice Activity Detection (VAD)
    ↓
Deepgram Flux (STT via WebSocket)
    ↓
[Optional] OpenClaw Gateway (LLM Processing)
    ↓
[Optional] TTS Service (Voice Response)
    ↓
Discord Voice Channel (Audio Output)
    ↓
Discord Thread/Channel (Conversation Logs)
```

## Cost Estimation

### Deepgram Flux Pricing
- **Light usage** (30 min/day): ~$6.93/month (~¥1,040)
- **Heavy usage** (2 hours/day): ~$27.72/month (~¥4,158)
- **Free tier**: $200 credit (approximately 7-29 months depending on usage)

### Other Costs
- **LLM**: Depends on OpenClaw/Claude/GPT usage (pay-as-you-go)
- **TTS**: Depends on service used (local deployment is free)

## Contributing

Contributions are welcome! Please note that this is an experimental project under active development.

## License

MIT License - See LICENSE file for details

## Related Links

- [OpenClaw Documentation](https://docs.openclaw.ai)
- [Deepgram API Documentation](https://developers.deepgram.com/)
- [Discord.js Documentation](https://discord.js.org/)

---

**Note**: This README reflects the project status as of February 2026. APIs and pricing may change.
