import { useState, useEffect, useRef } from "react";
import { View, Text, Button, StyleSheet, Alert } from "react-native";
import * as FileSystem from "expo-file-system/legacy";
import {
  useAudioRecorder,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  AudioQuality,
  IOSOutputFormat,
  type RecordingOptions,
} from "expo-audio";

// WebSocketエンドポイントの設定
// ローカル環境: ws://localhost:3000/realtime
// 本番環境: wss://your-api-gateway-endpoint/realtime
const WS_ENDPOINT_BASE = "ws://192.168.1.133:3000/realtime";

// Cookieの設定
const SESSION_COOKIE = "ACCOUNTS-SESSION-ID-LOCAL=";

// AAC録音オプション（できるだけストリーミングしやすい形式を狙う）
//
// NOTE:
// - Androidは `outputFormat: "aac_adts"` でADTSを狙える（ストリーム向き）
// - iOSは `AVAudioRecorder` の挙動が端末/OS依存。`.aac` + `MPEG4AAC` でADTSになることもあるが、
//   `m4a` コンテナで書かれる場合は「録音中の増分送信」が成立しないことがある（停止後送信にフォールバック）
const AAC_RECORDING_OPTIONS: RecordingOptions = {
  extension: ".aac",
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 32000,
  android: {
    outputFormat: "aac_adts",
    audioEncoder: "aac",
    sampleRate: 16000,
    audioSource: "voice_recognition",
  },
  ios: {
    outputFormat: IOSOutputFormat.MPEG4AAC,
    audioQuality: AudioQuality.MEDIUM,
    sampleRate: 16000,
    extension: ".aac",
  },
  web: {
    mimeType: "audio/aac",
    bitsPerSecond: 32000,
  },
};

const AAC_POLL_INTERVAL_MS = 250;
const AAC_MAX_READ_BYTES_PER_CHUNK = 64 * 1024;
const AAC_MAX_CHUNKS_PER_TICK = 8;

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
  const recordingIdRef = useRef<string | null>(null);
  const recordingStartedPromiseRef = useRef<{
    resolve: (recordingId: string) => void;
    reject: (error: Error) => void;
  } | null>(null);

  const audioRecorder = useAudioRecorder(AAC_RECORDING_OPTIONS, (status) => {
    if (status?.hasError) {
      const message = status.error ?? "録音エラーが発生しました";
      console.error("[Audio] Recorder error:", status);
      setError(message);
      setRecordingStatus(`録音エラー: ${message}`);
    }
  });

  // AACファイル増分送信用
  const aacFileUriRef = useRef<string | null>(null);
  const aacReadPositionRef = useRef<number>(0);
  const aacPollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const aacSendInFlightRef = useRef(false);
  const isRecordingRef = useRef(false);

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

  const stopAacPolling = () => {
    if (aacPollTimerRef.current) {
      clearInterval(aacPollTimerRef.current);
      aacPollTimerRef.current = null;
    }
  };

  const resolveAacFileUri = (): string | null => {
    if (aacFileUriRef.current) return aacFileUriRef.current;
    const uri = audioRecorder.uri ?? audioRecorder.getStatus().url ?? null;
    if (uri) aacFileUriRef.current = uri;
    return uri;
  };

  const guessContainerFromUri = (uri: string): "adts" | "m4a" | "unknown" => {
    const lower = uri.toLowerCase();
    if (lower.includes(".m4a")) return "m4a";
    if (lower.includes(".aac")) return "adts";
    return "unknown";
  };

  const sendPendingAacData = async (
    maxChunks: number = AAC_MAX_CHUNKS_PER_TICK
  ): Promise<{ bytesSent: number }> => {
    if (aacSendInFlightRef.current) return { bytesSent: 0 };
    aacSendInFlightRef.current = true;

    try {
      let bytesSent = 0;

      for (let i = 0; i < maxChunks; i++) {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) break;
        if (recordingIdRef.current === null) break;

        const fileUri = resolveAacFileUri();
        if (!fileUri) break;

        const info = await FileSystem.getInfoAsync(fileUri);
        if (!info.exists || typeof info.size !== "number") break;

        const available = info.size - aacReadPositionRef.current;
        if (available <= 0) break;

        const byteOffset = aacReadPositionRef.current;
        const byteLength = Math.min(available, AAC_MAX_READ_BYTES_PER_CHUNK);

        const base64Chunk = await FileSystem.readAsStringAsync(fileUri, {
          encoding: FileSystem.EncodingType.Base64,
          position: byteOffset,
          length: byteLength,
        });

        if (!base64Chunk) {
          aacReadPositionRef.current += byteLength;
          continue;
        }

        const container = guessContainerFromUri(fileUri);
        const eventId = generateEventId();
        const message = {
          type: "recording.audio_buffer.commit.v2",
          eventId,
          audio: base64Chunk,
        };

        ws.send(JSON.stringify(message));

        aacReadPositionRef.current += byteLength;
        bytesSent += byteLength;
        setSentDataCount((prev) => prev + 1);

        console.log(
          `[Audio] Sent AAC chunk: ${byteLength} bytes (offset=${byteOffset}, container=${container})`
        );
      }

      return { bytesSent };
    } catch (err) {
      console.warn("[Audio] Failed to send pending AAC data:", err);
      return { bytesSent: 0 };
    } finally {
      aacSendInFlightRef.current = false;
    }
  };

  const startAacPolling = () => {
    if (aacPollTimerRef.current) return;
    aacPollTimerRef.current = setInterval(() => {
      void sendPendingAacData();
    }, AAC_POLL_INTERVAL_MS);
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

        // React NativeのWebSocketは環境によって options(headers) をサポートするが、型定義(DOM)とは不一致
        // ここでは any キャストで対応（Cookie不要なら第3引数を削除してOK）
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ws = new (WebSocket as any)(wsUrl, null, {
          headers: {
            Cookie: cookieHeader,
          },
        }) as WebSocket;

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
    // 録音モードを事前に設定（iOSで必要になるケースがある）
    setAudioModeAsync({
      allowsRecording: true,
      playsInSilentMode: true,
    }).catch((err) => {
      console.warn("[Audio] Failed to set audio mode:", err);
    });

    return () => {
      // コンポーネントのアンマウント時にクリーンアップ
      stopAacPolling();
      if (isRecordingRef.current) {
        audioRecorder.stop().catch((err) => {
          console.warn("[Audio] Failed to stop recorder on unmount:", err);
        });
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      recordingIdRef.current = null;
      recordingStartedPromiseRef.current = null;
      aacFileUriRef.current = null;
      aacReadPositionRef.current = 0;
      isRecordingRef.current = false;
    };
  }, [audioRecorder]);

  // 録音を開始
  const startRecording = async () => {
    try {
      setError(null);

      // マイクの権限をリクエスト（Expo Audio）
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        Alert.alert("権限エラー", "マイクの権限が必要です");
        return;
      }

      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });

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
          audioFormat: "aac",
        };
        wsRef.current.send(JSON.stringify(startMessage));
        console.log("[WS] 録音開始イベントを送信しました:", eventId);

        // recording.started イベントを受信するまで待機
        await recordingStartedPromise;
        console.log("[WS] 録音が開始されました。AACデータの送信を開始します。");
      } else {
        throw new Error("WebSocket接続が確立されませんでした");
      }

      // AAC録音を開始（録音はファイルに書き込まれ、追記分をポーリングで送信する）
      aacFileUriRef.current = null;
      aacReadPositionRef.current = 0;
      setSentDataCount(0);

      await audioRecorder.prepareToRecordAsync();
      audioRecorder.record();

      // 端末によってはすぐにURIが出ないことがあるので、ポーリングも併用する
      void resolveAacFileUri();
      startAacPolling();

      setIsRecording(true);
      setRecordingStatus("録音中...");
      isRecordingRef.current = true;
      console.log("[Audio] ✅ Recording started (AAC)");
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
      stopAacPolling();

      // 録音停止（ファイル確定）
      try {
        await audioRecorder.stop();
      } catch (err) {
        console.warn("[Audio] Recorder stop warning:", err);
      }

      // 残りを可能な限り送信（録音停止後にサイズが増える場合があるため複数回トライ）
      for (let i = 0; i < 8; i++) {
        const { bytesSent } = await sendPendingAacData(32);
        if (bytesSent === 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }

      // recording.complete を最後に送信
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

      setIsRecording(false);
      isRecordingRef.current = false;
      setRecordingStatus("録音停止");
      setSentDataCount(0);
      setRecordingId(null);
      recordingIdRef.current = null;
      aacFileUriRef.current = null;
      aacReadPositionRef.current = 0;
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
