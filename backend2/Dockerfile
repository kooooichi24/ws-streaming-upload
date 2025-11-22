# AWS Fargate は x86_64 (amd64) アーキテクチャを使用
FROM --platform=linux/amd64 node:22-slim

# FFmpeg をインストール
RUN apt-get update && apt-get install -y \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 依存関係をコピーしてインストール（devDependencies も含む）
COPY package*.json ./
RUN npm ci

# アプリケーションコードをコピー
COPY . .

# TypeScript をビルド
RUN npm run build

# 本番用の依存関係のみを再インストール
RUN npm ci --only=production && npm cache clean --force

# ポートを公開
EXPOSE 3000

# アプリケーションを起動
CMD ["node", "dist/src/server.js"]
