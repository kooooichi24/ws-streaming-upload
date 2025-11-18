import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import {
  S3Client,
  PutObjectCommand,
  PutObjectCommandInput,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import {
  WebSocketEvent,
  WebSocketResponse,
  ConnectionItem,
  MessageBody,
  WebSocketMessage,
} from "./types/websocket";
import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const execAsync = promisify(exec);

// DynamoDBクライアントの設定（ローカル環境の場合はDynamoDB Local Dockerを使用）
const isOffline =
  process.env.IS_OFFLINE === "true" || process.env.IS_OFFLINE === "1";
const dynamoClient = new DynamoDBClient({
  region: isOffline ? "localhost" : "ap-northeast-1",
  endpoint: isOffline ? "http://localhost:8000" : undefined,
  credentials: isOffline
    ? {
        accessKeyId: "dummy",
        secretAccessKey: "dummy",
      }
    : undefined,
});
const dynamodb = DynamoDBDocumentClient.from(dynamoClient);

const CONNECTIONS_TABLE =
  process.env.CONNECTIONS_TABLE || "ws-streaming-upload-connections-dev";

// S3クライアントの設定（ローカル環境の場合はMinIOを使用）
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || "ws-streaming-upload-dev";
const s3Client = new S3Client({
  region: isOffline ? "us-east-1" : "ap-northeast-1",
  endpoint: isOffline ? "http://localhost:9000" : undefined,
  forcePathStyle: isOffline, // MinIOでは必須
  credentials: isOffline
    ? {
        accessKeyId: "minioadmin",
        secretAccessKey: "minioadmin",
      }
    : undefined,
});

// ApiGatewayManagementApiのエンドポイントを動的に取得
function getApiGatewayManagementApi(
  event: WebSocketEvent
): ApiGatewayManagementApiClient {
  let endpoint: string;

  if (isOffline) {
    endpoint = "http://localhost:3001";
  } else {
    // 本番環境: 通常のAPI Gatewayエンドポイント
    const domain = event.requestContext.domainName;
    const stage = event.requestContext.stage;
    endpoint = `https://${domain}/${stage}`;
  }

  // ローカル環境では認証情報を設定（serverless-offlineは認証を無視しますが、AWS SDK v3では必要）
  return new ApiGatewayManagementApiClient({
    endpoint: endpoint,
    region: isOffline ? "localhost" : "ap-northeast-1",
    credentials: isOffline
      ? {
          accessKeyId: "dummy",
          secretAccessKey: "dummy",
        }
      : undefined,
  });
}

// WebSocket接続時の処理
export const connect = async (
  event: WebSocketEvent
): Promise<WebSocketResponse> => {
  const connectionId = event.requestContext.connectionId;
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

    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Connected" }),
    };
  } catch (error) {
    console.error("Error connecting:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to connect" }),
    };
  }
};

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

    // 最小限の一時ディレクトリを作成（concat.txtのみ）
    const tmpDir = path.join(
      os.tmpdir(),
      `audio-${connectionId}-${Date.now()}`
    );
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      // チャンクをメモリから直接一時ファイルに書き込む（ffmpeg用）
      const chunkFiles: string[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const chunkFile = path.join(tmpDir, `chunk-${i}.tmp`);
        fs.writeFileSync(chunkFile, chunks[i]);
        chunkFiles.push(chunkFile);
      }

      // concatファイルリストを作成
      const concatListFile = path.join(tmpDir, "concat.webb");
      const concatListContent = chunkFiles
        .map((file) => `file '${file}'`)
        .join("\n");
      fs.writeFileSync(concatListFile, concatListContent);

      // ContentTypeから拡張子を取得
      const contentType =
        validResults[0]?.contentType || "application/octet-stream";
      const contentTypeToExtension: Record<string, string> = {
        "audio/mpeg": "mp3",
        "audio/mp3": "mp3",
        "audio/wav": "wav",
        "audio/x-wav": "wav",
        "audio/wave": "wav",
        "audio/ogg": "ogg",
        "audio/flac": "flac",
        "audio/mp4": "m4a",
        "audio/x-m4a": "m4a",
        "audio/aac": "aac",
        "audio/webm": "webm",
      };

      let outputExt = contentTypeToExtension[contentType] || "mp3";
      const outputFile = path.join(tmpDir, `combined.${outputExt}`);

      // ffmpegのパスを取得（Layerから）
      const ffmpegPath = isOffline
        ? "ffmpeg" // ローカル環境ではシステムのffmpegを使用
        : "/opt/bin/ffmpeg"; // Lambda Layerから

      // ffmpegで結合（concat demuxerを使用）
      const ffmpegCommand = `${ffmpegPath} -f concat -safe 0 -i "${concatListFile}" -c copy "${outputFile}" -y`;
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
        console.log(
          `✅ FFmpeg combined successfully: ${outputFileSize} bytes`
        );
      } else {
        // フォールバック: メモリ上のチャンクを直接結合
        console.warn(
          "⚠️  FFmpeg failed or output file not found, using simple concatenation from memory"
        );
        combinedAudio = Buffer.concat(chunks);
      }

      // ContentTypeを決定
      let finalContentType = contentType;
      const extensionToContentType: Record<string, string> = {
        mp3: "audio/mpeg",
        wav: "audio/wav",
        ogg: "audio/ogg",
        flac: "audio/flac",
        m4a: "audio/mp4",
        aac: "audio/aac",
        webm: "audio/webm",
      };
      finalContentType = extensionToContentType[outputExt] || finalContentType;

      const fileName = `combined.${outputExt}`;
      console.log(
        `Combined ${validResults.length} chunks into ${combinedAudio.length} bytes (ContentType: ${finalContentType})`
      );

      // 結合した音声データをS3に保存
      const finalObjectKey = `${connectionId}/combined-${Date.now()}-${fileName}`;
      const putCommand = new PutObjectCommand({
        Bucket: S3_BUCKET_NAME,
        Key: finalObjectKey,
        Body: combinedAudio,
        ContentType: finalContentType,
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

    // 元のチャンクファイルを削除（オプション）
    // 必要に応じてコメントアウトを解除
    // for (const obj of sortedObjects) {
    //   if (obj.Key) {
    //     await s3Client.send(
    //       new DeleteObjectCommand({
    //         Bucket: S3_BUCKET_NAME,
    //         Key: obj.Key,
    //       })
    //     );
    //   }
    // }
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
export const disconnect = async (
  event: WebSocketEvent
): Promise<WebSocketResponse> => {
  const connectionId = event.requestContext.connectionId;

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

    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Disconnected" }),
    };
  } catch (error) {
    console.error("Error disconnecting:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to disconnect" }),
    };
  }
};

// デフォルトのメッセージ処理
export const defaultHandler = async (
  event: WebSocketEvent
): Promise<WebSocketResponse> => {
  const connectionId = event.requestContext.connectionId;
  const body: MessageBody = JSON.parse(event.body || "{}");

  console.log(`Default message from ${connectionId}:`, body);

  try {
    const apigwManagementApi = getApiGatewayManagementApi(event);
    await sendMessageToConnection(apigwManagementApi, connectionId, {
      type: "error",
      message: 'Unknown action. Use "sendMessage" action.',
    });

    return {
      statusCode: 200,
    };
  } catch (error) {
    console.error("Error in default handler:", error);
    return {
      statusCode: 500,
    };
  }
};

// S3にオブジェクトをアップロード
async function uploadToS3(
  connectionId: string,
  data: string | Buffer,
  contentType: string
): Promise<string> {
  const timestamp = Date.now();
  const contentTypeToExtension: Record<string, string> = {
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
    "audio/ogg": "ogg",
    "audio/flac": "flac",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/aac": "aac",
    "audio/webm": "webm",
  };
  const extension = contentTypeToExtension[contentType] || "mp3";
  const objectKey = `${connectionId}/${timestamp}.${extension}`;

  const params: PutObjectCommandInput = {
    Bucket: S3_BUCKET_NAME,
    Key: objectKey,
    Body: typeof data === "string" ? Buffer.from(data, "base64") : data,
    ContentType: contentType,
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
export const upload = async (
  event: WebSocketEvent
): Promise<WebSocketResponse> => {
  const connectionId = event.requestContext.connectionId;
  const body: MessageBody = JSON.parse(event.body || "{}");

  console.log(`Upload request from ${connectionId}:`, {
    contentType: body.contentType,
    dataLength: body.data?.length,
    data: body.data,
  });

  try {
    const apigwManagementApi = getApiGatewayManagementApi(event);

    if (!body.data) {
      await sendMessageToConnection(apigwManagementApi, connectionId, {
        type: "upload-error",
        message: "No data provided",
        error: "Data field is required",
      });
      return {
        statusCode: 400,
      };
    }

    if (!body.contentType) {
      await sendMessageToConnection(apigwManagementApi, connectionId, {
        type: "upload-error",
        message: "No contentType provided",
        error: "ContentType field is required",
      });
      return {
        statusCode: 400,
      };
    }

    try {
      const { data, fileName, contentType } = body;
      const objectKey = await uploadToS3(connectionId, data, contentType);

      // アップロード成功をクライアントに通知
      await sendMessageToConnection(apigwManagementApi, connectionId, {
        type: "upload-success",
        message: "File uploaded successfully",
        data: {
          objectKey,
          bucket: S3_BUCKET_NAME,
        },
      });

      return {
        statusCode: 200,
      };
    } catch (uploadError) {
      console.error("Error uploading file:", uploadError);
      await sendMessageToConnection(apigwManagementApi, connectionId, {
        type: "upload-error",
        message: "Failed to upload file",
        error:
          uploadError instanceof Error
            ? uploadError.message
            : String(uploadError),
      });
      return {
        statusCode: 500,
      };
    }
  } catch (error) {
    console.error("Error in upload handler:", error);
    return {
      statusCode: 500,
    };
  }
};

// カスタムメッセージ送信処理
export const sendMessage = async (
  event: WebSocketEvent
): Promise<WebSocketResponse> => {
  const connectionId = event.requestContext.connectionId;
  const body: MessageBody = JSON.parse(event.body || "{}");

  console.log(`Message from ${connectionId}:`, body);

  try {
    const apigwManagementApi = getApiGatewayManagementApi(event);
    // 通常のメッセージを送信者にエコー
    await sendMessageToConnection(apigwManagementApi, connectionId, {
      type: "message",
      message: "Message received",
      data: body,
    });

    // 他の接続にブロードキャスト（オプション）
    // await broadcastMessage(apigwManagementApi, body);

    return {
      statusCode: 200,
    };
  } catch (error) {
    console.error("Error in sendMessage handler:", error);
    return {
      statusCode: 500,
    };
  }
};

// 特定の接続にメッセージを送信
async function sendMessageToConnection(
  apigwManagementApi: ApiGatewayManagementApiClient,
  connectionId: string,
  message: WebSocketMessage
): Promise<void> {
  try {
    await apigwManagementApi.send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: JSON.stringify(message),
      })
    );
  } catch (error: any) {
    // ローカル環境では404エラーを無視（serverless-offlineの制限）
    if (
      isOffline &&
      (error.statusCode === 404 || error.$metadata?.httpStatusCode === 404)
    ) {
      console.warn(
        `⚠️  Local environment: ApiGatewayManagementApi not fully supported by serverless-offline. ` +
          `Message would be sent to connection ${connectionId} in production.`
      );
      return;
    }
    if (error.statusCode === 410 || error.$metadata?.httpStatusCode === 410) {
      // 接続が既に切断されている場合、DynamoDBから削除
      console.log(`Connection ${connectionId} is gone, removing from table`);
      await dynamodb.send(
        new DeleteCommand({
          TableName: CONNECTIONS_TABLE,
          Key: { connectionId },
        })
      );
    } else {
      throw error;
    }
  }
}

// 全接続にブロードキャスト（オプション）
// async function broadcastMessage(
//   apigwManagementApi: ApiGatewayManagementApiClient,
//   message: WebSocketMessage
// ): Promise<void> {
//   const params = {
//     TableName: CONNECTIONS_TABLE,
//   };

//   try {
//     const result = await dynamodb.send(new ScanCommand(params));
//     if (result.Items) {
//       const promises = result.Items.map((item: ConnectionItem) =>
//         sendMessageToConnection(
//           apigwManagementApi,
//           item.connectionId,
//           message
//         ).catch((err) => {
//           console.error(`Failed to send to ${item.connectionId}:`, err);
//         })
//       );
//       await Promise.all(promises);
//     }
//   } catch (error) {
//     console.error("Error broadcasting message:", error);
//     throw error;
//   }
// }

// defaultHandlerをdefaultとしてエクスポート（serverless.ymlで使用）
export { defaultHandler as default };
