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
  WebSocketEvent,
  WebSocketResponse,
  ConnectionItem,
  MessageBody,
  WebSocketMessage,
} from "./types/websocket";

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

// ApiGatewayManagementApiのエンドポイントを動的に取得
function getApiGatewayManagementApi(
  event: WebSocketEvent
): ApiGatewayManagementApiClient {
  const domain = event.requestContext.domainName;
  const stage = event.requestContext.stage;
  const endpoint = `https://${domain}/${stage}`;

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
    console.log(`Connection established: ${connectionId}`);

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

// カスタムメッセージ送信処理
export const sendMessage = async (
  event: WebSocketEvent
): Promise<WebSocketResponse> => {
  const connectionId = event.requestContext.connectionId;
  const body: MessageBody = JSON.parse(event.body || "{}");

  console.log(`Message from ${connectionId}:`, body);

  try {
    const apigwManagementApi = getApiGatewayManagementApi(event);
    // メッセージを送信者にエコー
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
