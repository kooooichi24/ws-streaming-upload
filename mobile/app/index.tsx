import { useState, useEffect, useRef } from "react";
import { View, Text, Button, StyleSheet, Alert, PermissionsAndroid, Platform } from "react-native";
import LiveAudioStream from "react-native-live-audio-stream";

// WebSocketエンドポイントの設定
// ローカル環境: ws://localhost:3001
// 本番環境: wss://your-api-gateway-endpoint/dev
const WS_ENDPOINT = "ws://ws-streaming-upload-alb-dev-657914009.ap-northeast-1.elb.amazonaws.com";

// オーディオストリームの設定
// バックエンドのffmpegコマンドに合わせて設定:
// - sampleRate: 24000 (バックエンドは -ar 24000)
// - channels: 1 (バックエンドは -ac 1)
// - bitsPerSample: 16 (バックエンドは -f s16le)
const AUDIO_OPTIONS = {
  sampleRate: 24000,
  channels: 1,
  bitsPerSample: 16,
  audioSource: 6, // Androidのみ（デフォルトは6）
  bufferSize: 4096, // バッファサイズ
  wavFile: "", // WAVファイルへの保存は不要（空文字列）
};

interface WebSocketMessage {
  action: string;
  data?: string;
  contentType?: string;
  fileName?: string;
}

export default function Index() {
  const [isConnected, setIsConnected] = useState(false);
  const [recordingStatus, setRecordingStatus] = useState<string>("");
  const [isRecording, setIsRecording] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const dataListenerRef = useRef<((data: string) => void) | null>(null);

  // マイクの権限をリクエスト
  const requestMicrophonePermission = async (): Promise<boolean> => {
    if (Platform.OS === "android") {
      try {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
          {
            title: "マイクの権限",
            message: "音声録音のためにマイクの権限が必要です",
            buttonNeutral: "後で",
            buttonNegative: "拒否",
            buttonPositive: "許可",
          }
        );
        return granted === PermissionsAndroid.RESULTS.GRANTED;
      } catch (err) {
        console.error("Permission request error:", err);
        return false;
      }
    }
    // iOSの場合はInfo.plistで設定されている必要がある
    return true;
  };

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

  // クリーンアップ処理
  useEffect(() => {
    return () => {
      // コンポーネントのアンマウント時にクリーンアップ
      if (isRecording) {
        LiveAudioStream.stop();
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);

  // 録音を開始
  const startRecording = async () => {
    try {
      // マイクの権限をリクエスト
      const hasPermission = await requestMicrophonePermission();
      if (!hasPermission) {
        Alert.alert("権限エラー", "マイクの権限が必要です");
        return;
      }

      // WebSocketが接続されていない場合は接続
      if (!isConnected || wsRef.current?.readyState !== WebSocket.OPEN) {
        connectWebSocket();
        // 接続を待つ
        await new Promise<void>((resolve, reject) => {
          const maxWaitTime = 10000; // 最大10秒待機
          const startTime = Date.now();
          const checkConnection = setInterval(() => {
            if (wsRef.current?.readyState === WebSocket.OPEN) {
              clearInterval(checkConnection);
              resolve();
            } else if (Date.now() - startTime > maxWaitTime) {
              clearInterval(checkConnection);
              reject(new Error("WebSocket接続タイムアウト"));
            }
          }, 100);
        });
      }

      // オーディオストリームの初期化
      LiveAudioStream.init(AUDIO_OPTIONS);
      console.log("[Audio] Initialized with options:", AUDIO_OPTIONS);

      // データ受信時のリスナーを設定
      const dataListener = (base64Data: string) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
          console.warn("[Audio] WebSocket is not connected, skipping data");
          return;
        }

        // Base64エンコードされたPCMデータをそのまま送信
        const message: WebSocketMessage = {
          action: "upload",
          data: base64Data,
          contentType: "audio/pcm",
        };

        try {
          wsRef.current.send(JSON.stringify(message));
          console.log(`[Audio] Sent PCM chunk: ${base64Data.length} chars (base64)`);
        } catch (error) {
          console.error("[Audio] Error sending data:", error);
        }
      };

      // リスナーを登録
      LiveAudioStream.on("data", dataListener);
      dataListenerRef.current = dataListener;

      // オーディオストリームの開始
      LiveAudioStream.start();
      setIsRecording(true);
      setRecordingStatus("録音中...");
      console.log("[Audio] ✅ Recording started");
    } catch (error) {
      console.error("[Audio] Failed to start recording:", error);
      Alert.alert("エラー", "録音の開始に失敗しました");
    }
  };

  // 録音を停止
  const stopRecording = async () => {
    try {
      // オーディオストリームを停止（リスナーも自動的に削除される）
      LiveAudioStream.stop();
      dataListenerRef.current = null;
      setIsRecording(false);
      setRecordingStatus("録音停止");
      console.log("[Audio] ✅ Recording stopped");

      // WebSocketを切断（バックエンドで処理が完了するまで少し待つ）
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    } catch (error) {
      console.error("[Audio] Failed to stop recording:", error);
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
            isRecording && styles.recording,
          ]}
        >
          {isRecording ? "録音中" : "停止中"}
        </Text>
      </View>

      {recordingStatus ? (
        <Text style={styles.recordingStatus}>{recordingStatus}</Text>
      ) : null}

      <View style={styles.buttonContainer}>
        {!isRecording ? (
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
