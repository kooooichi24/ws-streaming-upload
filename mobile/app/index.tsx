import { useState, useEffect, useRef } from "react";
import { View, Text, Button, StyleSheet, Alert } from "react-native";
import {
  useAudioRecorder,
  useAudioRecorderState,
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
} from "expo-audio";
import { File } from "expo-file-system";

// WebSocketエンドポイントの設定
// ローカル環境: ws://localhost:3001
// 本番環境: wss://your-api-gateway-endpoint/dev
const WS_ENDPOINT = "wss://xhx738yp6f.execute-api.ap-northeast-1.amazonaws.com/dev";

// Uint8ArrayをBase64文字列に変換するヘルパー関数
function bytesToBase64(bytes: Uint8Array): string {
  // React Native環境では、btoaとString.fromCharCodeを使用
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  // btoaが利用可能な場合は使用（Web/Expo環境）
  if (typeof btoa !== 'undefined') {
    return btoa(binary);
  }
  // フォールバック: 手動でBase64エンコード
  // Base64文字セット
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  let i = 0;
  while (i < binary.length) {
    const a = binary.charCodeAt(i++);
    const b = i < binary.length ? binary.charCodeAt(i++) : 0;
    const c = i < binary.length ? binary.charCodeAt(i++) : 0;
    const bitmap = (a << 16) | (b << 8) | c;
    result += chars.charAt((bitmap >> 18) & 63);
    result += chars.charAt((bitmap >> 12) & 63);
    result += i - 2 < binary.length ? chars.charAt((bitmap >> 6) & 63) : '=';
    result += i - 1 < binary.length ? chars.charAt(bitmap & 63) : '=';
  }
  return result;
}

// 録音データを送信する間隔（ミリ秒）
const SEND_INTERVAL = 1000; // 1秒ごと

// チャンクサイズの制限（バイト単位）
// API Gateway WebSocketのメッセージサイズ制限（128KB）を考慮し、
// Base64エンコードで約33%増加するため、16KBに制限
// Base64エンコード後は約21KBになり、より安全なマージンを確保
const MAX_CHUNK_SIZE = 16 * 1024; // 16KB

interface WebSocketMessage {
  action: string;
  data?: string;
  contentType?: string;
  fileName?: string;
}

export default function Index() {
  const [isConnected, setIsConnected] = useState(false);
  const [recordingStatus, setRecordingStatus] = useState<string>("");
  const wsRef = useRef<WebSocket | null>(null);
  const sendIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastChunkSizeRef = useRef<number>(0);
  const isRecordingRef = useRef<boolean>(false); // 最新の録音状態を保持

  // expo-audioのレコーダーを使用
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(audioRecorder);

  // recorderState.isRecordingが変更されたら、refを更新
  useEffect(() => {
    isRecordingRef.current = recorderState.isRecording;
    console.log("[Recording] State updated:", recorderState.isRecording);
  }, [recorderState.isRecording]);

  // WebSocket接続を確立
  const connectWebSocket = () => {
    try {
      console.log(`[WS] Connecting to: ${WS_ENDPOINT}`);
      const ws = new WebSocket(WS_ENDPOINT);
      wsRef.current = ws;

      ws.onopen = (event) => {
        console.log("[WS] ✅ WebSocket connected", {
          readyState: ws.readyState,
          protocol: ws.protocol,
          url: ws.url,
        });
        setIsConnected(true);
        setRecordingStatus("WebSocket接続済み");
      };

      ws.onmessage = (event) => {
        try {
          console.log("[WS] 📨 Received message:", event.data);
          const message = JSON.parse(event.data);
          console.log("[WS] Parsed message:", message);

          if (message.type === "upload-success") {
            setRecordingStatus(
              `アップロード成功: ${message.data?.objectKey || ""}`
            );
          } else if (message.type === "upload-error") {
            setRecordingStatus(`アップロードエラー: ${message.error || ""}`);
            Alert.alert("エラー", message.error || "アップロードに失敗しました");
          }
        } catch (error) {
          console.error("[WS] ❌ Error parsing message:", error);
        }
      };

      ws.onerror = (error) => {
        console.error("[WS] ❌ WebSocket error:", error);
        console.error("[WS] Error details:", {
          readyState: ws.readyState,
          url: ws.url,
        });
        setRecordingStatus("WebSocketエラー");
        setIsConnected(false);
      };

      ws.onclose = (event) => {
        console.log("[WS] 🔌 WebSocket closed", {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
          readyState: ws.readyState,
        });
        setIsConnected(false);
        setRecordingStatus(`WebSocket切断 (code: ${event.code}, reason: ${event.reason || "none"})`);
      };
    } catch (error) {
      console.error("[WS] ❌ Failed to connect WebSocket:", error);
      Alert.alert("エラー", "WebSocket接続に失敗しました");
    }
  };

  // 録音を開始
  const startRecording = async () => {
    try {
      // マイクの権限をリクエスト
      const status = await AudioModule.requestRecordingPermissionsAsync();
      if (!status.granted) {
        Alert.alert("権限エラー", "マイクの権限が必要です");
        return;
      }

      // オーディオモードを設定
      await setAudioModeAsync({
        playsInSilentMode: true,
        allowsRecording: true,
      });

      // WebSocketが接続されていない場合は接続
      if (!isConnected || wsRef.current?.readyState !== WebSocket.OPEN) {
        connectWebSocket();
        // 接続を待つ
        await new Promise<void>((resolve) => {
          const checkConnection = setInterval(() => {
            if (wsRef.current?.readyState === WebSocket.OPEN) {
              clearInterval(checkConnection);
              resolve();
            }
          }, 100);
        });
      }

      // 録音の準備
      await audioRecorder.prepareToRecordAsync();
      
      // 録音を開始
      audioRecorder.record();
      setRecordingStatus("録音中...");
      lastChunkSizeRef.current = 0;

      // レコーディング中は送信しない（終了後にまとめて送信）
      // インターバルは削除
    } catch (error) {
      console.error("Failed to start recording:", error);
      Alert.alert("エラー", "録音の開始に失敗しました");
    }
  };

  // 録音を停止
  const stopRecording = async () => {
    try {
      if (sendIntervalRef.current) {
        clearInterval(sendIntervalRef.current);
        sendIntervalRef.current = null;
      }

      // 録音を停止
      await audioRecorder.stop();
      isRecordingRef.current = false; // 録音状態を更新
      
      // moov atomが書き込まれるまで待つ（ファイルサイズが安定し、moov atomが含まれるまで）
      let uri = audioRecorder.uri;
      if (uri) {
        let previousSize = 0;
        let stableCount = 0;
        const maxWaitTime = 10000; // 最大10秒待機
        const startTime = Date.now();
        let moovAtomFound = false;
        
        while (Date.now() - startTime < maxWaitTime && !moovAtomFound) {
          const file = new File(uri);
          const fileInfo = file.info();
          if (fileInfo.exists) {
            const currentSize = fileInfo.size || 0;
            
            // ファイルサイズが安定したか確認
            if (currentSize === previousSize) {
              stableCount++;
              if (stableCount >= 3) {
                // 3回連続でサイズが同じ = ファイルが完成
                console.log(`File size stabilized at ${currentSize} bytes`);
                
                // moov atomが含まれているか確認
                const allBytes = await file.bytes();
                const moovAtomIndex = Array.from(allBytes).findIndex((_, i) => {
                  if (i + 4 > allBytes.length) return false;
                  return (
                    allBytes[i] === 0x6D && // 'm'
                    allBytes[i + 1] === 0x6F && // 'o'
                    allBytes[i + 2] === 0x6F && // 'o'
                    allBytes[i + 3] === 0x76 // 'v'
                  );
                });
                
                if (moovAtomIndex !== -1) {
                  console.log(`✅ moov atom found at position ${moovAtomIndex}`);
                  moovAtomFound = true;
                  break;
                } else {
                  console.warn(`⚠️ moov atom not found yet, waiting... (stable count: ${stableCount})`);
                  // moov atomが見つからない場合は、もう少し待つ
                  stableCount = 0; // リセットして再チェック
                }
              }
            } else {
              stableCount = 0;
              previousSize = currentSize;
            }
          }
          
          await new Promise(resolve => setTimeout(resolve, 200)); // 200ms待機
        }
        
        if (!moovAtomFound) {
          console.error(`❌ moov atom not found after ${maxWaitTime}ms, but continuing...`);
        }
      }
      
      // レコーディング終了後、moov atomが確認できたらファイル全体を送信
      uri = audioRecorder.uri;
      if (!uri) {
        console.error("No recording URI");
        return;
      }

      const file = new File(uri);
      const fileInfo = file.info();
      if (!fileInfo.exists) {
        console.error("Recording file does not exist");
        return;
      }

      // ファイル全体を読み込む
      console.log("Reading entire file for sending...");
      const allBytes = await file.bytes();
      const fileSize = allBytes.length;
      console.log(`File size: ${fileSize} bytes`);

      // ファイル全体をチャンクに分割して送信
      let offset = 0;
      let chunkIndex = 0;
      
      while (offset < fileSize) {
        const remainingBytes = fileSize - offset;
        const chunkSize = Math.min(remainingBytes, MAX_CHUNK_SIZE);
        const chunkBytes = allBytes.slice(offset, offset + chunkSize);
        
        // Base64エンコード
        const base64Data = bytesToBase64(chunkBytes);

        // WebSocketメッセージを送信
        const message: WebSocketMessage = {
          action: "upload",
          data: base64Data,
          contentType: "audio/m4a",
        };

        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
          console.error("WebSocket is not connected");
          break;
        }

        wsRef.current.send(JSON.stringify(message));
        console.log(`Sent chunk ${chunkIndex}: offset=${offset}, size=${chunkSize}, remaining=${remainingBytes - chunkSize}`);

        offset += chunkSize;
        chunkIndex++;

        // 少し待ってから次のチャンクを送信（WebSocketの処理を待つ）
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      console.log(`All chunks sent: ${chunkIndex} chunks, total ${fileSize} bytes`);

      setRecordingStatus("録音停止");
      lastChunkSizeRef.current = 0;


      // WebSocketを切断
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    } catch (error) {
      console.error("Failed to stop recording:", error);
      Alert.alert("エラー", "録音の停止に失敗しました");
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>音声ストリーミングアップロード</Text>

      <View style={styles.statusContainer}>
        <Text style={styles.statusLabel}>接続状態:</Text>
        <Text style={[styles.statusValue, isConnected && styles.connected]}>
          {isConnected ? "接続中" : "未接続"}
        </Text>
      </View>

      <View style={styles.statusContainer}>
        <Text style={styles.statusLabel}>録音状態:</Text>
        <Text
          style={[
            styles.statusValue,
            recorderState.isRecording && styles.recording,
          ]}
        >
          {recorderState.isRecording ? "録音中" : "停止中"}
        </Text>
      </View>

      {recordingStatus ? (
        <Text style={styles.recordingStatus}>{recordingStatus}</Text>
      ) : null}

      <View style={styles.buttonContainer}>
        {!recorderState.isRecording ? (
          <Button
            title="録音開始"
            onPress={startRecording}
            color="#4CAF50"
          />
        ) : (
          <Button title="録音停止" onPress={stopRecording} color="#F44336" />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
    backgroundColor: "#f5f5f5",
  },
  title: {
    fontSize: 24,
    fontWeight: "bold",
    marginBottom: 30,
    color: "#333",
  },
  statusContainer: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 15,
  },
  statusLabel: {
    fontSize: 16,
    marginRight: 10,
    color: "#666",
  },
  statusValue: {
    fontSize: 16,
    fontWeight: "bold",
    color: "#999",
  },
  connected: {
    color: "#4CAF50",
  },
  recording: {
    color: "#F44336",
  },
  recordingStatus: {
    fontSize: 14,
    color: "#666",
    marginTop: 10,
    textAlign: "center",
  },
  buttonContainer: {
    marginTop: 30,
    width: "100%",
    maxWidth: 300,
  },
});
