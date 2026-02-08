# Discord音声ボット 設計書 v2

## 概要

OpenClawエージェントと音声で会話できるDiscord Botの設計書。
STT → LLM → TTSのパイプラインをリアルタイムで動作させ、会話ログをDiscordスレッドに記録する。

---

## アーキテクチャ

```
Discord VC (音声入力)
  ↓
@discordjs/voice (音声受信)
  ↓
VAD (Voice Activity Detection) ← 無音時はスキップ
  ↓
Deepgram Flux (STT, WebSocket) ← 喋った時間のみ課金
  ↓
OpenClaw Gateway (HTTP: /v1/chat/completions)
  ↓
agent:main ← 会話履歴・記憶統合
  ↓
TTS (OpenAI互換エンドポイント)
  - aivis-speech: ${TTS_BASE_URL}/v1/audio/speech
  ↓
Discord VC (音声出力)
  ↓
ログ記録 (指定チャンネルのスレッド)
```

---

## コンポーネント詳細

### 1. Discord VC接続
- **ライブラリ:** `@discordjs/voice`
- **機能:**
  - 指定されたボイスチャンネルに接続
  - 音声ストリーム受信（PCM 16bit 48kHz）
  - 音声ストリーム送信

### 2. VAD (Voice Activity Detection)
- **ライブラリ:** `@ricky0123/vad-node` または `node-webrtcvad`
- **目的:** 無音時にDeepgramへの送信を止めてコスト削減
- **設定:**
  - `threshold`: 0.0〜1.0（感度調整、デフォルト0.5）
  - 音声検出時のみDeepgramにストリーム送信

### 3. STT: Deepgram Flux
- **API:** Deepgram Streaming API (WebSocket)
- **モデル:** `flux`
- **特徴:**
  - 低レイテンシ
  - 割り込み検出対応
  - リアルタイムストリーミング
- **価格:** $0.0077/分（音声処理時間のみ）
- **無料枠:** $200クレジット（約433時間分）

### 4. LLM: OpenClaw Gateway (OpenAI Chat Completions互換API)

OpenClaw Gatewayは、OpenAI互換のHTTP Chat Completions APIを提供する。
内部的には通常のGateway agent実行と同じパスを使用するため、設定・権限・ルーティングはGatewayの構成に従う。

#### 基本情報
- **エンドポイント:** `http://127.0.0.1:18789/v1/chat/completions`
- **プロトコル:** HTTP POST
- **仕様:** OpenAI Chat Completions API互換

#### 有効化（必須）

**デフォルトでは無効**なため、Gateway設定で有効化が必要：

```json
{
  "gateway": {
    "http": {
      "endpoints": {
        "chatCompletions": { "enabled": true }
      }
    }
  }
}
```

#### 認証

**Gateway認証設定を使用**（Bearer token形式）：

```javascript
const openai = new OpenAI({
  apiKey: process.env.OPENCLAW_GATEWAY_TOKEN,  // gateway.auth.token
  baseURL: 'http://127.0.0.1:18789/v1'
});
```

**HTTPヘッダー:**
```
Authorization: Bearer <gateway.auth.token>
```

**認証モード:**
- `gateway.auth.mode="token"` → `gateway.auth.token` (または `OPENCLAW_GATEWAY_TOKEN`)
- `gateway.auth.mode="password"` → `gateway.auth.password` (または `OPENCLAW_GATEWAY_PASSWORD`)

#### エージェント指定

**3つの方法:**

**方法1: `model` パラメータ（推奨）**
```javascript
{
  model: "openclaw:main",  // または "agent:main"
  messages: [...]
}
```

**方法2: HTTPヘッダー**
```
x-openclaw-agent-id: main
```

**方法3: セッションキー（上級）**
```
x-openclaw-session-key: <custom-session-key>
```

#### セッション管理

**`user` パラメータでセッション識別:**
```javascript
{
  model: "openclaw:main",
  user: `discord:${userId}`,  // 安定したセッションキー生成
  messages: [{ role: 'user', content: userMessage }]
}
```

**動作:**
- `user` パラメータがある → Gatewayが安定したセッションキーを生成
- 同じ `user` 値 → 同じエージェントセッション → 会話履歴を保持
- `user` パラメータなし → 毎回新しいセッション（ステートレス）

**セッション形式:**
- Discord音声: `discord:${userId}`
- Discordテキスト: `discord:${userId}` （同じ → 記憶共有）
- 分離したい場合: `discord-voice:${userId}` など

#### リクエスト仕様

**基本リクエスト:**
```javascript
const response = await openai.chat.completions.create({
  model: 'openclaw:main',           // または "agent:main"
  user: `discord:${userId}`,        // セッション識別子
  messages: [
    { role: 'user', content: userMessage }
  ],
  stream: false                     // ストリーミング無効（音声向け）
});
```

**パラメータ:**

| パラメータ | 必須 | 説明 |
|----------|------|------|
| `model` | ✅ | `"openclaw:main"` または `"agent:main"` |
| `user` | 推奨 | セッション識別子（例: `discord:123456789012345678`） |
| `messages` | ✅ | メッセージ配列 `[{role, content}]` |
| `stream` | ❌ | SSE (Server-Sent Events) ストリーミング |
| `temperature` | ❌ | 温度（通常は指定不要、エージェント側で管理） |

**ストリーミング（SSE）:**
```javascript
{
  model: 'openclaw:main',
  stream: true,  // SSEストリーミング有効化
  messages: [...]
}
```

- Content-Type: `text/event-stream`
- 各イベント行: `data: <json>`
- 終了: `data: [DONE]`

#### レスポンス仕様

**成功時（非ストリーミング）:**
```javascript
{
  id: 'chatcmpl-abc123',
  object: 'chat.completion',
  created: 1707350220,
  model: 'openclaw:main',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: 'いい選択！Fluxは低レイテンシで割り込み検出も対応してるよ'
      },
      finish_reason: 'stop'
    }
  ],
  usage: {
    prompt_tokens: 42,
    completion_tokens: 28,
    total_tokens: 70
  }
}
```

**アクセス方法:**
```javascript
const assistantMessage = response.choices[0].message.content;
```

#### エラーハンドリング

**HTTPステータスコード:**

| ステータス | 原因 | 対処法 |
|-----------|------|--------|
| 401 | 認証失敗 | Bearer tokenを確認 |
| 404 | エンドポイント無効 | Gateway設定で有効化 |
| 400 | 不正なリクエスト | パラメータを確認 |
| 500 | サーバーエラー | リトライ、ログ確認 |
| 503 | サービス利用不可 | Gateway起動状態確認 |

**実装例:**
```javascript
try {
  const response = await openai.chat.completions.create({
    model: 'openclaw:main',
    user: `discord:${userId}`,
    messages: [{ role: 'user', content: userMessage }]
  });
  
  return response.choices[0].message.content;
  
} catch (error) {
  if (error.status === 401) {
    console.error('認証エラー: Bearer tokenを確認してください');
  } else if (error.status === 404) {
    console.error('Chat Completionsエンドポイントが無効です。Gateway設定で有効化してください。');
  } else if (error.status === 503) {
    console.error('Gatewayが利用できません。起動状態を確認してください');
  } else {
    console.error('OpenClaw Gateway エラー:', error.message);
  }
  throw error;
}
```

#### 実装例（完全版）

```javascript
import OpenAI from 'openai';

// 初期化
const openai = new OpenAI({
  apiKey: process.env.OPENCLAW_GATEWAY_TOKEN,
  baseURL: 'http://127.0.0.1:18789/v1'
});

// メッセージ送信関数
async function sendToAgent(userId, userMessage) {
  try {
    const response = await openai.chat.completions.create({
      model: 'openclaw:main',
      user: `discord:${userId}`,
      messages: [
        { role: 'user', content: userMessage }
      ],
      stream: false
    });
    
    const assistantMessage = response.choices[0].message.content;
    console.log('エージェントの応答:', assistantMessage);
    
    return assistantMessage;
    
  } catch (error) {
    console.error('OpenClaw Gateway エラー:', error);
    throw error;
  }
}

// 使用例
const response = await sendToAgent('123456789012345678', 'Deepgramでfluxが良さそうかなぁ');
// → "いい選択！Fluxは低レイテンシで割り込み検出も対応してるよ"
```

#### ログ記録への統合

```javascript
async function handleVoiceMessage(userId, userMessage, threadId) {
  // 1. ユーザー発言をログ記録
  await logToDiscord(threadId, {
    author: config.discord.userDisplayName,  // 環境変数から取得
    message: userMessage,
    emoji: '👤'
  });
  
  // 2. OpenClaw Gatewayにメッセージ送信
  const assistantMessage = await sendToAgent(userId, userMessage);
  
  // 3. エージェント応答をログ記録
  await logToDiscord(threadId, {
    author: config.discord.botDisplayName,  // 環境変数から取得
    message: assistantMessage,
    emoji: '🤖'
  });
  
  // 4. TTS生成・再生
  await speakResponse(assistantMessage);
  
  return assistantMessage;
}
```

#### メリット
- ✅ OpenAI SDKをそのまま使える（移行が容易）
- ✅ 会話履歴・セッション管理はOpenClaw側
- ✅ テキストチャットと音声チャットで記憶共有
- ✅ モデル・プロンプトの変更がBot側に影響しない
- ✅ Gateway設定でエージェント管理（ルーティング、権限、ツール）

### 5. TTS: OpenAI互換エンドポイント
- **BaseURL:** 設定ファイルで指定（例: aivis-speech）
- **エンドポイント:** `/v1/audio/speech`
- **仕様:** OpenAI TTS API互換

**リクエスト例:**
```javascript
await fetch(`${config.tts.baseURL}/audio/speech`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: config.tts.model,
    input: text,
    voice: config.tts.voice,
    speed: config.tts.speed
  })
});
```

---

## ログ記録システム

### 記録先
- **チャンネル:** 環境変数で指定 (`DISCORD_LOG_CHANNEL_ID`)
- **形式:** 1通話1スレッド

### スレッド管理

#### 「1通話」の判定（ハイブリッド方式）

**基本ルール:**
- 切断後**30分以内**に再接続 → 同じスレッドに続ける
- 切断後**30分以上**経過 → 新しいスレッド作成

**手動制御（2つの方法）:**

1. **テキストコマンド:** `/voice new`
   - 任意のチャンネルで実行
   - 次回接続時、強制的に新スレッド作成

2. **接続時ボタン:**
   - VC接続時、ログチャンネルにメッセージ表示
   - **VADが最初の発言を検知するまで表示継続**
   - ボタン内容:
     ```
     通話を開始しますか？
     [📝 前回の続き] [🆕 新規]
     ```
   - 押さなければ基本ルール（30分判定）に従う

#### ボタン表示フロー
```
VC接続
  ↓
状態チェック（30分判定 + forceNewThread）
  ↓
greeting再生開始
  ↓
同時にログチャンネルにボタン表示
  ↓
【待機】greeting再生中もボタン表示継続
  ↓
VADが最初の発言を検知 or ボタン押下
  ↓
スレッド確定、ボタン削除
  ↓
通常の音声対話開始
```

### ログフォーマット

**スレッド名:**
```
🎙️ 音声通話 2026-02-08 00:15
```

**メッセージ形式:**
```
👤 ユーザー名 (00:15:32)
Deepgramでfluxが良さそうかなぁ

🤖 ボット名 (00:15:35)
いい選択！Fluxは低レイテンシで割り込み検出も対応してるよ
```

**通話終了時:**
```
─────────────────
🔚 通話終了 (00:28:50)
通話時間: 13分18秒
─────────────────
```

### 状態管理

**ファイル:** `state/voice-session.json`

```json
{
  "userId": "123456789012345678",
  "currentThreadId": "987654321098765432",
  "lastDisconnect": 1707350220,
  "forceNewThread": false
}
```

---

## 接続時サウンド（Greeting）

### 機能
- VC接続時に自動再生される定型サウンド
- 2つの方式: ファイル or TTS生成

### 設定

```yaml
greeting:
  enabled: true
  type: "tts"  # or "file"
  text: "おかえり！"
  file: "./sounds/greeting.mp3"  # type: "file" の場合のみ使用
```

### TTS事前生成
- **タイミング:** Bot起動時
- **保存先:** `./cache/greeting.opus`
- **目的:** 接続時のレイテンシ削減

**フロー:**
```
Bot起動
  ↓
config読み込み
  ↓
type: "tts" の場合
  ↓
TTSエンドポイントで音声生成
  ↓
./cache/greeting.opus に保存
  ↓
起動完了
```

**接続時:**
```
VC接続
  ↓
greeting.opus を再生
  ↓
（同時にボタン表示）
  ↓
通常モード開始
```

---

## 設定ファイル仕様

**ファイル:** `config/voice-bot.yml`

```yaml
# Discord設定
discord:
  token: "${DISCORD_TOKEN}"
  guildId: "${DISCORD_GUILD_ID}"
  voiceChannelId: "${DISCORD_VOICE_CHANNEL_ID}"
  logChannelId: "${DISCORD_LOG_CHANNEL_ID}"
  userDisplayName: "${DISCORD_USER_DISPLAY_NAME}"  # ログ表示用のユーザー名
  botDisplayName: "${DISCORD_BOT_DISPLAY_NAME}"    # ログ表示用のボット名

# STT設定
stt:
  provider: "deepgram"
  apiKey: "${DEEPGRAM_API_KEY}"
  model: "flux"
  language: "ja"  # または "en", "multi"
  
# VAD設定
vad:
  enabled: true
  threshold: 0.5  # 感度（0.0〜1.0）

# OpenClaw Gateway
openclaw:
  baseURL: "http://127.0.0.1:18789/v1"
  token: "${OPENCLAW_GATEWAY_TOKEN}"
  agent: "main"

# TTS設定（全体共通、OpenAI互換）
tts:
  baseURL: "${TTS_BASE_URL}"  # 例: "http://192.168.0.58:10102/v1"
  model: "tts-1"
  voice: "nova"
  speed: 1.0

# 接続時サウンド
greeting:
  enabled: true
  type: "tts"  # or "file"
  text: "おかえり！"
  file: "./sounds/greeting.mp3"  # type: "file" 時のみ

# 切断時（テキストのみ）
farewell:
  enabled: true
  message: "🔚 通話終了"
  showDuration: true

# セッション管理
session:
  timeoutMinutes: 30  # 30分以内なら同じスレッド
  buttonDisplayMode: "until-first-speech"  # または "disabled"
```

---

## Gateway設定（必須）

**OpenClaw Gateway側の設定も必要:**

`~/.openclaw/openclaw.json` または `OPENCLAW_CONFIG_PATH` 指定ファイル:

```json
{
  "gateway": {
    "auth": {
      "mode": "token",
      "token": "YOUR_GATEWAY_TOKEN"  // またはOPENCLAW_GATEWAY_TOKEN環境変数
    },
    "http": {
      "endpoints": {
        "chatCompletions": {
          "enabled": true  // デフォルトfalse、必ず有効化
        }
      }
    }
  }
}
```

**設定反映:**
```bash
# Gateway再起動（設定反映）
openclaw gateway restart
```

---

## Docker構成

### Dockerfile

```dockerfile
FROM node:22-alpine

WORKDIR /app

# 必要なパッケージ（FFmpeg, Opus）
RUN apk add --no-cache ffmpeg opus-dev

# 依存関係インストール
COPY package.json package-lock.json ./
RUN npm ci --production

# アプリケーションコード
COPY . .

# キャッシュディレクトリ作成
RUN mkdir -p cache state logs

CMD ["node", "src/index.js"]
```

### docker-compose.yml

```yaml
services:
  voice-bot:
    build: .
    restart: unless-stopped
    network_mode: "host"  # OpenClaw Gateway + ローカルTTSにアクセス
    environment:
      - DISCORD_TOKEN=${DISCORD_TOKEN}
      - DISCORD_GUILD_ID=${DISCORD_GUILD_ID}
      - DISCORD_VOICE_CHANNEL_ID=${DISCORD_VOICE_CHANNEL_ID}
      - DISCORD_LOG_CHANNEL_ID=${DISCORD_LOG_CHANNEL_ID}
      - DISCORD_USER_DISPLAY_NAME=${DISCORD_USER_DISPLAY_NAME}
      - DISCORD_BOT_DISPLAY_NAME=${DISCORD_BOT_DISPLAY_NAME}
      - DEEPGRAM_API_KEY=${DEEPGRAM_API_KEY}
      - OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN}
      - TTS_BASE_URL=${TTS_BASE_URL}
    volumes:
      - ./config:/app/config:ro
      - ./cache:/app/cache
      - ./state:/app/state
      - ./logs:/app/logs
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

### .env.example

```bash
# Discord設定
DISCORD_TOKEN=your_discord_bot_token
DISCORD_GUILD_ID=your_guild_id
DISCORD_VOICE_CHANNEL_ID=your_voice_channel_id
DISCORD_LOG_CHANNEL_ID=your_log_channel_id
DISCORD_USER_DISPLAY_NAME=User
DISCORD_BOT_DISPLAY_NAME=Bot

# STT設定
DEEPGRAM_API_KEY=your_deepgram_api_key

# OpenClaw Gateway設定
OPENCLAW_GATEWAY_TOKEN=your_openclaw_gateway_token

# TTS設定
TTS_BASE_URL=http://localhost:10102/v1
```

---

## 実装フェーズ

### Phase 1: 基本実装
1. Discord Bot作成（VC接続、音声受信）
2. VAD統合
3. Deepgram Flux接続（STT）
4. OpenClaw Gateway連携（Chat Completions API）
5. TTS接続（OpenAI互換）
6. Discord VC音声送信

### Phase 2: ログ記録システム
1. ログチャンネルのスレッド作成・管理
2. 発言ログ記録（タイムスタンプ付き）
3. セッション状態管理（30分判定）
4. `/voice new` コマンド実装
5. 接続時ボタン実装（VAD検知まで表示）

### Phase 3: Greeting/Farewell
1. TTS事前生成システム
2. 接続時greeting再生
3. 切断時テキスト投稿

### Phase 4: 最適化・エラーハンドリング
1. 割り込み（barge-in）対応
2. レイテンシチューニング
3. 再接続ロジック
4. エラーログ・モニタリング

### Phase 5: Docker化・デプロイ
1. Dockerfile作成
2. docker-compose.yml
3. 環境変数テンプレート
4. デプロイ手順書

---

## 技術スタック

- **Runtime:** Node.js 22
- **Discord:** discord.js, @discordjs/voice
- **STT:** Deepgram SDK
- **VAD:** @ricky0123/vad-node
- **LLM:** OpenAI SDK（OpenClaw Gateway Chat Completions経由）
- **Audio:** FFmpeg, Opus
- **Container:** Docker, Docker Compose

---

## 想定環境

- **実行場所:** サーバーまたはローカルマシン
- **ネットワーク:** OpenClaw GatewayおよびTTSサービスへのアクセス必要
- **依存サービス:**
  - OpenClaw Gateway (localhost:18789)
  - TTS サービス (設定で指定)

---

## コスト試算

### Deepgram Flux
- **軽い使い方（1日30分）:** $6.93/月（約1,040円）
- **ヘビーユース（1日2時間）:** $27.72/月（約4,158円）
- **無料枠:** $200（約29〜7ヶ月分）

### その他
- **TTS:** 使用するサービスによる（ローカルの場合は無料）
- **LLM:** OpenClaw側のコスト（Claude/GPTの従量課金）

---

## 参考資料

- **OpenClaw Docs:** https://docs.openclaw.ai
- **OpenAI Chat Completions API:** https://docs.openclaw.ai/gateway/openai-http-api
- **Gateway Runbook:** https://docs.openclaw.ai/gateway
- **Deepgram Pricing:** https://deepgram.com/pricing

---

## 備考

- この設計は2026年2月時点のもの
- Deepgram API仕様・価格は変更される可能性あり
- 実装時は最新ドキュメント参照を推奨
- **重要:** OpenClaw Gateway側で Chat Completions APIを有効化すること
