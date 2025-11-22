# FFmpeg Lambda Layer

このLayerにはFFmpegバイナリが含まれています。

## セットアップ方法

### 方法1: 既存のLambda Layerを使用（推奨）

AWSには既にFFmpegを含む公開Layerが存在します。以下のARNを使用できます：

- `arn:aws:lambda:ap-northeast-1:898466741470:layer:ffmpeg:1` (ap-northeast-1)

### 方法2: 独自のLayerを作成

1. FFmpegバイナリをダウンロード：
   ```bash
   # Amazon Linux 2用のFFmpegバイナリをダウンロード
   # 例: https://johnvansickle.com/ffmpeg/ からダウンロード
   # または DockerでAmazon Linux 2環境を作成してビルド
   ```

2. `bin/`ディレクトリに配置：
   ```bash
   cp ffmpeg layers/ffmpeg/bin/
   chmod +x layers/ffmpeg/bin/ffmpeg
   ```

3. デプロイ：
   ```bash
   serverless deploy
   ```

## 使用方法

Lambda関数内で `/opt/bin/ffmpeg` としてアクセスできます。

