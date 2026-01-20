import { useState, useEffect, useRef } from "react";
import {
  View,
  Text,
  Button,
  StyleSheet,
  Alert,
  PermissionsAndroid,
  Platform,
} from "react-native";
import LiveAudioStream from "react-native-live-audio-stream";

// WebSocketエンドポイントの設定
// ローカル環境: ws://localhost:3000/realtime
// 本番環境: wss://your-api-gateway-endpoint/realtime
const WS_ENDPOINT_BASE = "ws://192.168.1.124:3000/realtime";

// Cookieの設定
const SESSION_COOKIE = "ACCOUNTS-SESSION-ID-LOCAL=";

// オーディオストリームの設定
// バックエンドのffmpegコマンドに合わせて設定:
// - sampleRate: 16000 (バックエンドは -ar 16000)
// - channels: 1 (バックエンドは -ac 1)
// - bitsPerSample: 16 (バックエンドは -f s16le)
const AUDIO_OPTIONS = {
  sampleRate: 16000,
  channels: 1,
  bitsPerSample: 16,
  audioSource: 6, // Androidのみ（デフォルトは6）
  bufferSize: 4096, // バッファサイズ
  wavFile: "", // WAVファイルへの保存は不要（空文字列）
};

// サーバーイベントの型定義
type ServerEvent =
  | { type: "recording.started"; recordingId: string }
  | { type: "recording.audio_buffer.committed"; recordingId: string }
  | { type: "recording.merging_started"; recordingId: string }
  | {
      type: "error";
      error: {
        type: string;
        code: string;
        message: string;
        eventId: string | null;
        params: Record<string, unknown> | null;
      };
    };

// UUID v4を生成（React Native対応）
const generateEventId = (): string => {
  // React Nativeではcrypto.randomUUID()が使えない可能性があるため、代替実装
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // フォールバック: 簡易UUID生成
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

export default function Index() {
  const [isConnected, setIsConnected] = useState(false);
  const [recordingStatus, setRecordingStatus] = useState<string>("");
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [sentDataCount, setSentDataCount] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const dataListenerRef = useRef<((data: string) => void) | null>(null);
  const recordingIdRef = useRef<string | null>(null);
  const recordingStartedPromiseRef = useRef<{
    resolve: (recordingId: string) => void;
    reject: (error: Error) => void;
  } | null>(null);

  // サーバーイベントを処理
  const handleServerEvent = (event: ServerEvent) => {
    switch (event.type) {
      case "recording.started":
        setRecordingId(event.recordingId);
        recordingIdRef.current = event.recordingId;
        console.log("[WS] 録音が開始されました:", event.recordingId);
        // 録音開始のPromiseを解決
        if (recordingStartedPromiseRef.current) {
          recordingStartedPromiseRef.current.resolve(event.recordingId);
          recordingStartedPromiseRef.current = null;
        }
        break;
      case "recording.audio_buffer.committed":
        console.log(
          "[WS] オーディオバッファがコミットされました:",
          event.recordingId
        );
        break;
      case "recording.merging_started":
        console.log("[WS] 録音のマージが開始されました:", event.recordingId);
        setRecordingStatus("録音のマージが開始されました");
        break;
      case "error": {
        const errorMessage = event.error.message;
        setError(errorMessage);
        console.error("[WS] サーバーエラー:", event.error);
        Alert.alert("エラー", errorMessage);
        // エラーが発生した場合、録音開始のPromiseを拒否
        if (recordingStartedPromiseRef.current) {
          recordingStartedPromiseRef.current.reject(new Error(errorMessage));
          recordingStartedPromiseRef.current = null;
        }
        break;
      }
    }
  };

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

  // WebSocket接続を確立（Promiseを返す）
  const connectWebSocket = (): Promise<void> => {
    return new Promise((resolve, reject) => {
      // Promiseが既に解決/拒否されたかどうかを追跡
      let isResolved = false;
      let isRejected = false;

      const safeReject = (error: Error) => {
        if (!isResolved && !isRejected) {
          isRejected = true;
          reject(error);
        }
      };

      const safeResolve = () => {
        if (!isResolved && !isRejected) {
          isResolved = true;
          resolve();
        }
      };

      try {
        const cookieHeader = `${SESSION_COOKIE}=fixed-value`;

        const wsUrl = WS_ENDPOINT_BASE;

        console.log(`[WS] Connecting to: ${WS_ENDPOINT_BASE}`);
        console.log(`[WS] Cookie: ${cookieHeader}`);
        console.log(`[WS] Full URL: ${wsUrl.substring(0, 100)}...`); // URLが長い場合は省略

        // 標準のWebSocket接続を使用（React Nativeではheadersオプションが使えない）
        const ws = new WebSocket(wsUrl, null, {
          headers: {
            Cookie: cookieHeader,
          },
        });

        // 接続が確立されたかどうかを追跡
        let connectionEstablished = false;

        // タイムアウトを設定（10秒）
        const timeout = setTimeout(() => {
          if (!connectionEstablished && ws.readyState !== WebSocket.OPEN) {
            ws.close();
            const errorMessage =
              "WebSocket接続タイムアウト。サーバーが起動しているか確認してください。";
            setError(errorMessage);
            setRecordingStatus("WebSocket接続タイムアウト");
            safeReject(new Error(errorMessage));
          }
        }, 10000);

        wsRef.current = ws;

        ws.onopen = (event) => {
          console.log("[WS] ✅ WebSocket connected", {
            readyState: ws.readyState,
            protocol: ws.protocol,
            url: ws.url,
          });
          clearTimeout(timeout);
          connectionEstablished = true;
          setIsConnected(true);
          setRecordingStatus("WebSocket接続済み");
          safeResolve();
        };

        ws.onmessage = (event) => {
          try {
            console.log("[WS] 📨 Received message:", event.data);
            const message = JSON.parse(event.data);
            console.log("[WS] Parsed message:", message);

            // サーバーイベントを処理
            handleServerEvent(message as ServerEvent);
          } catch (error) {
            console.error("[WS] ❌ Error parsing message:", error);
          }
        };

        ws.onerror = (error) => {
          console.error("[WS] ❌ WebSocket error:", error);
          clearTimeout(timeout);

          // 接続が拒否された場合のエラーメッセージ
          let errorMessage = "WebSocket接続エラーが発生しました";
          if (ws.readyState === WebSocket.CLOSED) {
            errorMessage =
              "WebSocket接続が拒否されました。サーバーが起動しているか確認してください。";
          }

          setError(errorMessage);
          setRecordingStatus("WebSocketエラー");
          setIsConnected(false);
          safeReject(new Error(errorMessage));
        };

        ws.onclose = (event) => {
          console.log("[WS] 🔌 WebSocket closed", {
            code: event.code,
            reason: event.reason,
            wasClean: event.wasClean,
            readyState: ws.readyState,
          });
          clearTimeout(timeout);
          setIsConnected(false);
          setRecordingId(null);
          recordingIdRef.current = null;

          // 接続が確立される前に閉じられた場合のみreject
          if (!connectionEstablished) {
            const errorMessage =
              event.reason ||
              `WebSocket接続が拒否されました (code: ${event.code})。サーバーが起動しているか確認してください。`;
            setError(errorMessage);
            setRecordingStatus(`WebSocket切断: ${errorMessage}`);
            safeReject(new Error(errorMessage));
          } else {
            // 接続が確立された後に閉じられた場合は、通常の切断として扱う
            if (!event.wasClean && event.code !== 1000) {
              const errorMessage =
                event.reason ||
                `WebSocket接続が異常終了しました (code: ${event.code})`;
              setError(errorMessage);
              setRecordingStatus(`WebSocket切断: ${errorMessage}`);
            } else {
              setRecordingStatus(
                `WebSocket切断 (code: ${event.code}, reason: ${
                  event.reason || "none"
                })`
              );
            }
          }
        };
      } catch (error) {
        console.error("[WS] ❌ Failed to connect WebSocket:", error);
        const errorMessage =
          error instanceof Error
            ? error.message
            : "WebSocket接続に失敗しました";
        setError(errorMessage);
        Alert.alert("エラー", errorMessage);
        safeReject(error instanceof Error ? error : new Error(errorMessage));
      }
    });
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
      recordingIdRef.current = null;
      recordingStartedPromiseRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 録音を開始
  const startRecording = async () => {
    try {
      setError(null);

      // マイクの権限をリクエスト
      const hasPermission = await requestMicrophonePermission();
      if (!hasPermission) {
        Alert.alert("権限エラー", "マイクの権限が必要です");
        return;
      }

      // WebSocketが接続されていない場合は接続
      if (!isConnected || wsRef.current?.readyState !== WebSocket.OPEN) {
        await connectWebSocket();
      }

      // recording.start イベントを送信し、recording.started を待つ
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        // recording.started を待つPromiseを作成
        const recordingStartedPromise = new Promise<string>(
          (resolve, reject) => {
            recordingStartedPromiseRef.current = { resolve, reject };
            // タイムアウトを設定（10秒）
            setTimeout(() => {
              if (recordingStartedPromiseRef.current) {
                recordingStartedPromiseRef.current.reject(
                  new Error("録音開始のタイムアウト")
                );
                recordingStartedPromiseRef.current = null;
              }
            }, 10000);
          }
        );

        const eventId = generateEventId();
        const startMessage = {
          type: "recording.start",
          eventId,
        };
        wsRef.current.send(JSON.stringify(startMessage));
        console.log("[WS] 録音開始イベントを送信しました:", eventId);

        // recording.started イベントを受信するまで待機
        await recordingStartedPromise;
        console.log("[WS] 録音が開始されました。PCMデータの送信を開始します。");
      } else {
        throw new Error("WebSocket接続が確立されませんでした");
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

        // recordingIdが設定されている場合のみ送信
        if (recordingIdRef.current === null) {
          console.warn("[Audio] Recording ID is not set, skipping data");
          return;
        }

        // recording.audio_buffer.commit イベントとして送信
        const eventId = generateEventId();
        const message = {
          type: "recording.audio_buffer.commit",
          eventId,
          audio: base64Data,
        };

        try {
          wsRef.current.send(JSON.stringify(message));
          setSentDataCount((prev) => prev + 1);
          console.log(
            `[Audio] Sent PCM chunk: ${base64Data.length} chars (base64)`
          );
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
      const errorMessage =
        error instanceof Error ? error.message : "録音の開始に失敗しました";
      setError(errorMessage);
      console.error("[Audio] Failed to start recording:", error);
      Alert.alert("エラー", errorMessage);
    }
  };

  // 録音を停止
  const stopRecording = async () => {
    try {
      // recording.complete イベントを送信
      if (
        wsRef.current &&
        wsRef.current.readyState === WebSocket.OPEN &&
        recordingIdRef.current !== null
      ) {
        try {
          const eventId = generateEventId();
          const completeMessage = {
            type: "recording.complete",
            eventId,
          };
          wsRef.current.send(JSON.stringify(completeMessage));
          console.log("[WS] 録音完了イベントを送信しました:", eventId);
        } catch (err) {
          console.error("[WS] 録音完了イベント送信エラー:", err);
        }
      }

      // オーディオストリームを停止（リスナーも自動的に削除される）
      LiveAudioStream.stop();
      dataListenerRef.current = null;
      setIsRecording(false);
      setRecordingStatus("録音停止");
      setSentDataCount(0);
      setRecordingId(null);
      recordingIdRef.current = null;
      console.log("[Audio] ✅ Recording stopped");

      // WebSocketを切断（バックエンドで処理が完了するまで少し待つ）
      await new Promise((resolve) => setTimeout(resolve, 1000));

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
        <Text style={[styles.statusValue, isRecording && styles.recording]}>
          {isRecording ? "録音中" : "停止中"}
        </Text>
      </View>

      {error && (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {recordingStatus ? (
        <Text style={styles.recordingStatus}>{recordingStatus}</Text>
      ) : null}

      {recordingId && (
        <View style={styles.infoContainer}>
          <Text style={styles.infoText}>録音ID: {recordingId}</Text>
          <Text style={styles.infoText}>送信データ数: {sentDataCount}</Text>
        </View>
      )}

      <View style={styles.buttonContainer}>
        {!isRecording ? (
          <Button title="録音開始" onPress={startRecording} color="#4CAF50" />
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
  errorContainer: {
    backgroundColor: "#ffebee",
    borderColor: "#f44336",
    borderWidth: 1,
    borderRadius: 4,
    padding: 12,
    marginTop: 10,
    width: "100%",
    maxWidth: 300,
  },
  errorText: {
    color: "#c62828",
    fontSize: 14,
  },
  infoContainer: {
    marginTop: 10,
    width: "100%",
    maxWidth: 300,
  },
  infoText: {
    fontSize: 12,
    color: "#666",
    marginBottom: 4,
  },
  buttonContainer: {
    marginTop: 30,
    width: "100%",
    maxWidth: 300,
  },
});
