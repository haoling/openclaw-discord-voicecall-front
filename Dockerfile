FROM node:22-alpine AS builder

WORKDIR /app

# ビルドツールとlibsodiumをインストール
RUN apk add --no-cache python3 make g++ libsodium-dev

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ ./src/
RUN yarn build

FROM node:22-alpine

WORKDIR /app

# ランタイム依存関係をインストール（libsodium、ffmpeg）
RUN apk add --no-cache libsodium ffmpeg

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production && yarn cache clean

COPY --from=builder /app/dist ./dist
COPY assets/ ./assets/

CMD ["node", "dist/index.js"]
