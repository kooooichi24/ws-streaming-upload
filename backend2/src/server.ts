import { WebSocketServer, WebSocket } from "ws";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { randomUUID } from "crypto";
import {
  handleConnect,
  handleDisconnect,
  handleMessage,
  handleUpload,
} from "./websocket-handler";

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.url === "/health" && req.method === "GET") {
    console.log("Health check request received");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
});
const wss = new WebSocketServer({ server, path: "/" });

wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
  // 接続IDを生成（ALB では自動生成されないため、自前で管理）
  // UUID v4 を使用して一意性を保証
  const connectionId = randomUUID();

  console.log(`New WebSocket connection: ${connectionId}`);

  // 接続時の処理
  handleConnect(connectionId)
    .then(() => {
      ws.send(JSON.stringify({ type: "connected", message: "Connected" }));
    })
    .catch((error: Error) => {
      console.error("Error in connect handler:", error);
      ws.send(JSON.stringify({ type: "error", error: "Failed to connect" }));
    });

  // メッセージ受信時の処理
  ws.on("message", async (data: Buffer) => {
    try {
      const message = JSON.parse(data.toString());
      const { action } = message;

      console.log(`Message from ${connectionId}:`, { action, message });

      switch (action) {
        case "sendMessage":
          await handleMessage(connectionId, message, ws);
          break;
        case "upload":
          await handleUpload(connectionId, message, ws);
          break;
        default:
          await handleMessage(connectionId, message, ws);
          break;
      }
    } catch (error: unknown) {
      console.error("Error processing message:", error);
      ws.send(
        JSON.stringify({
          type: "error",
          message: "Failed to process message",
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
  });

  // 切断時の処理
  ws.on("close", async () => {
    console.log(`WebSocket connection closed: ${connectionId}`);
    await handleDisconnect(connectionId);
  });

  // エラー処理
  ws.on("error", (error: Error) => {
    console.error(`WebSocket error for ${connectionId}:`, error);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`WebSocket server ready at ws://localhost:${PORT}/`);
});
