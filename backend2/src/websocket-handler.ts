import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  S3Client,
  PutObjectCommand,
  PutObjectCommandInput,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { WebSocket } from "ws";
import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  ConnectionItem,
  MessageBody,
  WebSocketMessage,
} from "./types/websocket";

const execAsync = promisify(exec);

// 環境変数から設定を取得
const STAGE = process.env.STAGE || "dev";
const SERVICE = process.env.SERVICE || "ws-streaming-upload";
const CONNECTIONS_TABLE =
  process.env.CONNECTIONS_TABLE || `${SERVICE}-connections-${STAGE}`;
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || `${SERVICE}-${STAGE}`;
const AWS_REGION = process.env.AWS_REGION || "ap-northeast-1";

// DynamoDBクライアントの設定
const dynamoClient = new DynamoDBClient({
  region: AWS_REGION,
});
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);

// S3クライアントの設定
const s3Client = new S3Client({
  region: AWS_REGION,
});

// WebSocket接続時の処理
export async function handleConnect(connectionId: string): Promise<void> {
  const timestamp = Math.floor(Date.now() / 1000);
  // TTLを24時間後に設定
  const ttl = timestamp + 24 * 60 * 60;

  const params = {
    TableName: CONNECTIONS_TABLE,
    Item: {
      connectionId,
      connectedAt: timestamp,
      ttl,
    } as ConnectionItem,
  };

  try {
    await dynamodb.send(new PutCommand(params));
    console.log(`Connection established: ${connectionId}`, params);
  } catch (error) {
    console.error("Error connecting:", error);
    throw error;
  }
}

// S3から接続IDに関連するオブジェクトを取得して音声データに復号
async function processAudioDataFromS3(connectionId: string): Promise<void> {
  try {
    // 接続IDに関連するすべてのオブジェクトをリストアップ
    const listCommand = new ListObjectsV2Command({
      Bucket: S3_BUCKET_NAME,
      Prefix: `${connectionId}/`,
    });

    const listResponse = await s3Client.send(listCommand);
    const objects = listResponse.Contents || [];

    if (objects.length === 0) {
      console.log(`No objects found for connection ${connectionId}`);
      return;
    }

    // タイムスタンプ順にソート（ファイル名にタイムスタンプが含まれている）
    const sortedObjects = objects.sort((a, b) => {
      const timestampA = a.Key?.match(/\/(\d+)-/)?.[1] || "0";
      const timestampB = b.Key?.match(/\/(\d+)-/)?.[1] || "0";
      return parseInt(timestampA) - parseInt(timestampB);
    });

    console.log(
      `Found ${sortedObjects.length} objects for connection ${connectionId}`
    );

    // 有効なオブジェクトのみをフィルタリング
    const validObjects = sortedObjects.filter((obj) => obj.Key);
    if (validObjects.length === 0) {
      console.log(`No valid objects found for connection ${connectionId}`);
      return;
    }

    // 並列でオブジェクトを取得（順序を保持）
    const getPromises = validObjects.map(async (obj, index) => {
      const getCommand = new GetObjectCommand({
        Bucket: S3_BUCKET_NAME,
        Key: obj.Key!,
      });

      const getResponse = await s3Client.send(getCommand);
      console.log("getResponse", getResponse);
      if (!getResponse.Body) {
        console.warn(`No body found for object ${obj.Key}`);
        return null;
      }

      const chunk = await streamToBuffer(getResponse.Body);
      return {
        index,
        chunk,
        contentType: getResponse.ContentType || "application/octet-stream",
        key: obj.Key!,
      };
    });

    const results = await Promise.all(getPromises);
    const validResults = results.filter(
      (result): result is NonNullable<typeof result> => result !== null
    );

    if (validResults.length === 0) {
      console.log(`No valid data found for connection ${connectionId}`);
      return;
    }

    // インデックス順にソート
    validResults.sort((a, b) => a.index - b.index);

    // メモリ上でチャンクを保持
    const chunks = validResults.map((r) => r.chunk);

    // 最小限の一時ディレクトリを作成
    const tmpDir = path.join(
      os.tmpdir(),
      `audio-${connectionId}-${Date.now()}`
    );
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      const outputExt = "pcm";

      // すべてのチャンクをメモリ上で結合
      const combinedInput = Buffer.concat(chunks);
      const inputFile = path.join(tmpDir, `input.${outputExt}`);
      fs.writeFileSync(inputFile, combinedInput);
      console.log(
        `Combined ${chunks.length} chunks into input file: ${combinedInput.length} bytes`
      );

      const outputFile = path.join(tmpDir, `combined.mp3`);

      // ffmpegのパス（コンテナ内ではシステムのffmpegを使用）
      const ffmpegPath = "ffmpeg";

      // ffmpegでMP3に変換（1つの入力ファイルのみ）
      const ffmpegCommand = `${ffmpegPath} -f s16le -ar 24000 -ac 1 -i "${inputFile}" -c:a libmp3lame -b:a 192k "${outputFile}" -y`;
      console.log(`Executing ffmpeg: ${ffmpegCommand}`);

      let ffmpegSuccess = false;
      try {
        const { stdout, stderr } = await execAsync(ffmpegCommand, {
          maxBuffer: 10 * 1024 * 1024, // 10MB
        });
        if (stderr) {
          console.log("FFmpeg stderr:", stderr);
          // ffmpegは通常、ログをstderrに出力するが、エラーではない場合もある
          if (!stderr.includes("error") && !stderr.includes("Error")) {
            ffmpegSuccess = true;
          }
        } else {
          ffmpegSuccess = true;
        }
        if (stdout) {
          console.log("FFmpeg stdout:", stdout);
        }
      } catch (ffmpegError: any) {
        console.error("FFmpeg error:", ffmpegError);
        console.error("FFmpeg error message:", ffmpegError.message);
        console.error("FFmpeg error stderr:", ffmpegError.stderr);
        console.error("FFmpeg error stdout:", ffmpegError.stdout);
        ffmpegSuccess = false;
      }

      // 結合したファイルを読み込む
      let combinedAudio: Buffer;
      console.log("ffmpegSuccess", ffmpegSuccess);
      if (ffmpegSuccess && fs.existsSync(outputFile)) {
        combinedAudio = fs.readFileSync(outputFile);
        const outputFileSize = fs.statSync(outputFile).size;
        console.log(`✅ FFmpeg combined successfully: ${outputFileSize} bytes`);
      } else {
        // フォールバック: メモリ上のチャンクを直接結合
        console.warn(
          "⚠️  FFmpeg failed or output file not found, using simple concatenation from memory"
        );
        combinedAudio = Buffer.concat(chunks);
      }

      console.log(
        `Combined ${validResults.length} chunks into ${combinedAudio.length} bytes (ContentType: audio/mpeg)`
      );

      // 結合した音声データをS3に保存
      const finalObjectKey = `${connectionId}/combined-${Date.now()}-combined.mp3`;
      const putCommand = new PutObjectCommand({
        Bucket: S3_BUCKET_NAME,
        Key: finalObjectKey,
        Body: combinedAudio,
        ContentType: "audio/mpeg",
      });

      await s3Client.send(putCommand);
      console.log(`✅ Combined audio saved to S3: ${finalObjectKey}`);
    } finally {
      // 一時ファイルをクリーンアップ
      try {
        if (fs.existsSync(tmpDir)) {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          console.log(`Cleaned up temporary directory: ${tmpDir}`);
        }
      } catch (cleanupError) {
        console.warn(`Failed to cleanup temporary directory: ${cleanupError}`);
      }
    }
  } catch (error) {
    console.error(`Error processing audio data for ${connectionId}:`, error);
    throw error;
  }
}

// StreamをBufferに変換するヘルパー関数
async function streamToBuffer(
  stream: ReadableStream | Blob | any
): Promise<Buffer> {
  // Node.js環境ではReadableStreamまたはNode.jsのReadableストリーム
  if (stream && typeof stream.on === "function") {
    // Node.jsのReadableストリーム
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve(Buffer.concat(chunks)));
    });
  } else if (stream instanceof Blob) {
    // Blobの場合
    const arrayBuffer = await stream.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } else if (stream && typeof stream.getReader === "function") {
    // ReadableStreamの場合
    const reader = stream.getReader();
    const chunks: Buffer[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks);
    } finally {
      reader.releaseLock();
    }
  } else {
    throw new Error("Unsupported stream type");
  }
}

// WebSocket切断時の処理
export async function handleDisconnect(connectionId: string): Promise<void> {
  const params = {
    TableName: CONNECTIONS_TABLE,
    Key: {
      connectionId,
    },
  };

  try {
    // S3から接続IDに関連するbase64データを取得して音声データに復号
    await processAudioDataFromS3(connectionId);

    await dynamodb.send(new DeleteCommand(params));
    console.log(`Connection closed: ${connectionId}`);
  } catch (error) {
    console.error("Error disconnecting:", error);
    throw error;
  }
}

// S3にオブジェクトをアップロード
async function uploadToS3(
  connectionId: string,
  data: string | Buffer
): Promise<string> {
  const timestamp = Date.now();
  const objectKey = `${connectionId}/${timestamp}.pcm`;

  const params: PutObjectCommandInput = {
    Bucket: S3_BUCKET_NAME,
    Key: objectKey,
    Body: typeof data === "string" ? Buffer.from(data, "base64") : data,
    ContentType: "audio/pcm",
  };

  try {
    await s3Client.send(new PutObjectCommand(params));
    console.log(`✅ Uploaded to S3: ${objectKey}`);
    return objectKey;
  } catch (error) {
    console.error("❌ Error uploading to S3:", error);
    throw error;
  }
}

// ファイルアップロード処理
export async function handleUpload(
  connectionId: string,
  body: MessageBody,
  ws: WebSocket
): Promise<void> {
  console.log(`Upload request from ${connectionId}:`, {
    contentType: body.contentType,
    dataLength: body.data?.length,
    data: body.data,
  });

  if (!body.data) {
    sendMessageToConnection(ws, {
      type: "upload-error",
      message: "No data provided",
      error: "Data field is required",
    });
    return;
  }

  try {
    const { data } = body;
    const objectKey = await uploadToS3(connectionId, data);

    // アップロード成功をクライアントに通知
    sendMessageToConnection(ws, {
      type: "upload-success",
      message: "File uploaded successfully",
      data: {
        objectKey,
        bucket: S3_BUCKET_NAME,
      },
    });
  } catch (uploadError) {
    console.error("Error uploading file:", uploadError);
    sendMessageToConnection(ws, {
      type: "upload-error",
      message: "Failed to upload file",
      error:
        uploadError instanceof Error
          ? uploadError.message
          : String(uploadError),
    });
  }
}

// カスタムメッセージ送信処理
export async function handleMessage(
  connectionId: string,
  body: MessageBody,
  ws: WebSocket
): Promise<void> {
  console.log(`Message from ${connectionId}:`, body);

  // 通常のメッセージを送信者にエコー
  sendMessageToConnection(ws, {
    type: "message",
    message: "Message received",
    data: body,
  });
}

// 特定の接続にメッセージを送信
function sendMessageToConnection(
  ws: WebSocket,
  message: WebSocketMessage
): void {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    } else {
      console.warn("WebSocket is not open, cannot send message");
    }
  } catch (error) {
    console.error("Error sending message:", error);
  }
}
