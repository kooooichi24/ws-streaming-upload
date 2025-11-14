import WebSocket from "ws";

const WS_URL = process.env.WS_URL || "ws://localhost:3001";

console.log(`🔌 Connecting to WebSocket: ${WS_URL}`);

const ws = new WebSocket(WS_URL);

ws.on("open", () => {
  console.log("✅ WebSocket connection opened");

  // 接続確認メッセージを送信
  setTimeout(() => {
    console.log("\n📤 Sending test message...");
    const message = {
      action: "sendMessage",
      data: {
        message: "Hello from test client!",
        timestamp: new Date().toISOString(),
      },
    };
    ws.send(JSON.stringify(message));
  }, 1000);

  // ファイルアップロードのテスト
  setTimeout(() => {
    console.log("\n📤 Sending file upload request...");
    // テスト用のテキストデータをBase64エンコード
    const testContent =
      "This is a test file content for WebSocket streaming upload.";
    const base64Data = Buffer.from(testContent).toString("base64");

    const uploadMessage = {
      action: "upload",
      data: base64Data,
      fileName: "test-file.txt",
      contentType: "text/plain",
    };
    ws.send(JSON.stringify(uploadMessage));
  }, 3000);
});

ws.on("message", (data: WebSocket.Data) => {
  try {
    const message = JSON.parse(data.toString());
    console.log("\n📥 Received message:", JSON.stringify(message, null, 2));
  } catch (error) {
    console.log("\n📥 Received raw message:", data.toString());
  }
});

ws.on("error", (error: Error) => {
  console.error("❌ WebSocket error:", error);
});

ws.on("close", (code: number, reason: Buffer) => {
  console.log(
    `\n🔌 WebSocket connection closed (code: ${code}, reason: ${reason.toString()})`
  );
  process.exit(0);
});

// 100秒後に接続を閉じる
setTimeout(() => {
  console.log("\n⏰ Closing connection after 10 seconds...");
  ws.close();
}, 100000);

// Ctrl+Cで終了
process.on("SIGINT", () => {
  console.log("\n👋 Closing connection...");
  ws.close();
});
