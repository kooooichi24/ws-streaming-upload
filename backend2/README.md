# WebSocket Streaming Upload Backend (CDK)

ALB + Fargate 構成で WebSocket ストリーミングアップロードを提供するバックエンドアプリケーションです。

## 構成

- **Application Load Balancer (ALB)**: WebSocket をサポートするロードバランサー
- **ECS Fargate**: コンテナ化された WebSocket サーバー
- **DynamoDB**: 接続管理用テーブル
- **S3**: ファイルストレージ

## セットアップ

### 前提条件

- Node.js 22.x 以上
- AWS CLI が設定されていること
- CDK CLI がインストールされていること

```bash
npm install -g aws-cdk
```

### インストール

```bash
cd backend2
npm install
```

### ビルド

```bash
npm run build
```

### デプロイ

```bash
# CDK ブートストラップ（初回のみ）
cdk bootstrap

# デプロイ
npm run cdk:deploy

# ステージを指定してデプロイ
cdk deploy --context stage=prod
```

### ローカル開発

#### TypeScript開発サーバー（ホットリロード）

```bash
# 開発サーバーを起動
npm run dev
```

#### Dockerでローカル実行（本番環境に近い状態で確認）

```bash
# Dockerイメージをビルド
docker build -t ws-streaming-upload-backend .

# 環境変数を設定して実行
docker run -p 3000:3000 \
  -e STAGE=local \
  -e SERVICE=ws-streaming-upload \
  -e CONNECTIONS_TABLE=ws-streaming-upload-connections-local \
  -e S3_BUCKET_NAME=ws-streaming-upload-local \
  -e AWS_REGION=ap-northeast-1 \
  -e PORT=3000 \
  -v ~/.aws:/root/.aws:ro \
  ws-streaming-upload-backend

# または docker-compose を使用
docker-compose -f docker-compose.local.yml up --build
```

#### ヘルスチェック確認

```bash
# ヘルスチェックエンドポイントを確認
curl http://localhost:3000/health
```

#### WebSocket接続テスト

```bash
# wscat を使用して接続テスト（インストール: npm install -g wscat）
wscat -c ws://localhost:3000/
```

## 環境変数

以下の環境変数が ECS タスクに設定されます：

- `STAGE`: 環境ステージ（dev, prod など）
- `SERVICE`: サービス名
- `CONNECTIONS_TABLE`: DynamoDB テーブル名
- `S3_BUCKET_NAME`: S3 バケット名
- `AWS_REGION`: AWS リージョン
- `PORT`: アプリケーションのポート（デフォルト: 3000）

## WebSocket エンドポイント

デプロイ後、以下のコマンドで WebSocket エンドポイントを取得できます：

```bash
aws cloudformation describe-stacks \
  --stack-name WsStreamingUploadStack \
  --query 'Stacks[0].Outputs[?OutputKey==`WebSocketEndpoint`].OutputValue' \
  --output text
```

## 削除

```bash
npm run cdk:destroy
```

