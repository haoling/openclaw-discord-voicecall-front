# OpenClaw Discord 音声通話ボット

[English README is here](./README.md)

## 概要

OpenClawエージェントとリアルタイムで音声会話ができるDiscordボットです。STT（音声認識） → LLM → TTS のパイプラインを実装し、Discordのボイスチャンネルを通じてAIエージェントと対話できます。

## 目的

このボットはDiscordのボイスチャンネルに接続し、Deepgramの音声認識サービスを使用してユーザーの発話をリアルタイムで文字起こしし、指定されたDiscordチャンネル/スレッドにログを記録します。設計にはOpenClaw Gatewayを使用したLLM処理と、TTSによる音声応答機能も含まれています。

## 機能

### このボットができること

- ✅ Discordのボイスチャンネルに自動接続
- ✅ Deepgram Fluxを使用したリアルタイム音声認識
- ✅ VAD（Voice Activity Detection）による文字起こしコストの削減
- ✅ Discordチャンネル/スレッドへのタイムスタンプ付き会話ログ記録
- ✅ 日本語音声認識のサポート
- ✅ 接続失敗時の自動再接続
- ✅ グレースフルシャットダウン処理

### このボットができないこと（まだ）

- ⚠️ **限定的なLLM連携**: OpenClaw Gatewayとの連携機能は設計されていますが、実装が部分的な可能性があります
- ⚠️ **限定的なTTS連携**: TTSによる音声応答機能は設計されていますが、追加のセットアップが必要な場合があります
- ⚠️ **多言語サポートなし**: 現在は日本語の文字起こしに最適化されています
- ⚠️ **単一ボイスチャンネル**: 一度に1つのボイスチャンネルのみに接続できます

## 必要なもの

### 環境

- Node.js 22以上
- npmまたはyarn
- FFmpeg（音声処理用）

### 必須の認証情報

1. **Discord Bot Token**
   - [Discord Developer Portal](https://discord.com/developers/applications)でボットを作成
   - 「Message Content Intent」と「Server Members Intent」を有効化
   - 音声権限を付与してサーバーに招待

2. **Deepgram APIキー**
   - [Deepgram](https://deepgram.com/)でサインアップ
   - 無料枠には$200クレジット（約433時間分の文字起こし）が含まれます

3. **Discord チャンネルID**
   - ボイスチャンネルID（ボットが接続する場所）
   - ログチャンネルID（文字起こし結果を投稿する場所）

### オプション（全機能を使用する場合）

- **OpenClaw Gateway**: LLMを使用した応答生成用
- **TTSサービス**: OpenAI互換のTTSエンドポイント（音声応答用）

## 技術スタック

- **ランタイム**: Node.js 22
- **言語**: TypeScript
- **Discord**: discord.js v14, @discordjs/voice
- **音声認識**: Deepgram SDK（Fluxモデル）
- **音声処理**: FFmpeg, Opus, prism-media
- **暗号化**: libsodium-wrappers
- **LLM連携**（オプション）: OpenAI SDK → OpenClaw Gateway
- **コンテナ**（オプション）: Docker, Docker Compose

## インストール

### 1. リポジトリのクローン

```bash
git clone <repository-url>
cd openclaw-discord-voicecall-front
```

### 2. 依存関係のインストール

```bash
npm install
```

### 3. 環境変数の設定

サンプル環境ファイルをコピーして、認証情報を入力します：

```bash
cp .env.example .env
```

`.env`ファイルを編集して認証情報を設定：

```env
DISCORD_BOT_TOKEN=your_discord_bot_token
DISCORD_LOG_CHANNEL_ID=your_log_channel_id
DISCORD_VOICE_CHANNEL_ID=your_voice_channel_id
DEEPGRAM_API_KEY=your_deepgram_api_key

# オプション: OpenClaw Gateway連携
# CHAT_COMPLETION_ENDPOINT_URL=https://api.openai.com/v1/chat/completions
# CHAT_COMPLETION_APIKEY=your_api_key
# CHAT_COMPLETION_MODEL=gpt-4

# オプション: TTS連携
# TTS_ENDPOINT_URL=https://api.openai.com/v1/audio/speech
# TTS_MODEL=tts-1
# TTS_VOICE=alloy
# TTS_SPEED=1.0

# オプション: 音量閾値（デフォルト: 150）
# VOLUME_THRESHOLD=150

# オプション: 無音判定の基準時間（デフォルト: 1500ms）
# BASE_SILENCE_TIME=1500
```

### 4. ビルド

```bash
npm run build
```

### 5. 実行

**開発モード（ホットリロード付き）:**
```bash
npm run dev
```

**本番モード:**
```bash
npm run build
npm start
```

## Dockerデプロイ

### Docker Composeを使用（推奨）

```bash
# まず.envファイルを編集してください
docker-compose up -d
```

### 手動でDockerビルド

```bash
docker build -t openclaw-voice-bot .
docker run -d --env-file .env openclaw-voice-bot
```

## 使い方

1. **ボットの起動**: `npm run dev`または`npm start`を実行
2. **ボイスチャンネルに参加**: ボットが設定されたボイスチャンネルに自動接続します
3. **話し始める**: ボイスチャンネルで話すと、ボットが音声を文字起こしします
4. **ログを確認**: 文字起こし結果が設定されたログチャンネルに表示されます

## 重要な免責事項

⚠️ **このボットは完全にデバッグされておらず、開発中です。**

- **自己責任でご使用ください**: このソフトウェアにはバグ、未実装の機能、予期しない動作が含まれる可能性があります
- **保証なし**: このプロジェクトは「現状のまま」提供され、いかなる保証もありません
- **開発状況**: 設計書に記載されている機能が完全に実装されていない場合があります
- **破壊的変更**: APIや設定は予告なく変更される可能性があります
- **本番環境での使用**: 十分なテストなしに本番環境で使用することは推奨されません

### 既知の制限事項

- 設計仕様の一部機能が未完成または欠落している可能性があります
- エラーハンドリングがすべてのエッジケースをカバーしていない可能性があります
- 高負荷環境でのパフォーマンスは最適化されていません
- ドキュメントが不完全または古い可能性があります

## アーキテクチャ

```
Discord ボイスチャンネル（音声入力）
    ↓
@discordjs/voice（音声受信）
    ↓
Voice Activity Detection（VAD）
    ↓
Deepgram Flux（STT via WebSocket）
    ↓
【オプション】OpenClaw Gateway（LLM処理）
    ↓
【オプション】TTSサービス（音声応答）
    ↓
Discord ボイスチャンネル（音声出力）
    ↓
Discord スレッド/チャンネル（会話ログ）
```

## コスト試算

### Deepgram Flux料金
- **軽い使い方**（1日30分）: 約$6.93/月（約¥1,040）
- **ヘビーユース**（1日2時間）: 約$27.72/月（約¥4,158）
- **無料枠**: $200クレジット（使用量に応じて7〜29ヶ月分）

### その他のコスト
- **LLM**: OpenClaw/Claude/GPTの使用量による（従量課金）
- **TTS**: 使用するサービスによる（ローカルデプロイは無料）

## コントリビューション

コントリビューションを歓迎します！ただし、このプロジェクトは開発中の実験的なプロジェクトであることにご注意ください。

## ライセンス

MIT License - 詳細はLICENSEファイルを参照してください

## 関連リンク

- [OpenClaw ドキュメント](https://docs.openclaw.ai)
- [Deepgram API ドキュメント](https://developers.deepgram.com/)
- [Discord.js ドキュメント](https://discord.js.org/)

---

**注意**: このREADMEは2026年2月時点のプロジェクト状況を反映しています。APIや料金は変更される可能性があります。
