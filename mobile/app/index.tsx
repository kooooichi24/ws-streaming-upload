import { useState, useEffect, useRef } from "react";
import { View, Text, Button, StyleSheet, Alert, Platform } from "react-native";
import {
  useAudioRecorder,
  useAudioRecorderState,
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
} from "expo-audio";
import * as FileSystem from "expo-file-system";

// WebSocketエンドポイントの設定
// ローカル環境: ws://localhost:3001
// 本番環境: wss://your-api-gateway-endpoint/dev
const WS_ENDPOINT = __DEV__
  ? "ws://localhost:3001"
  : "wss://your-api-gateway-endpoint/dev";

// 録音データを送信する間隔（ミリ秒）
const SEND_INTERVAL = 5000; // 5秒ごと

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
  const isSendingChunkRef = useRef<boolean>(false);

  // expo-audioのレコーダーを使用
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(audioRecorder);

  // WebSocket接続を確立
  const connectWebSocket = () => {
    try {
      const ws = new WebSocket(WS_ENDPOINT);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log("WebSocket connected");
        setIsConnected(true);
        setRecordingStatus("WebSocket接続済み");
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          console.log("Received message:", message);

          if (message.type === "upload-success") {
            setRecordingStatus(
              `アップロード成功: ${message.data?.objectKey || ""}`
            );
          } else if (message.type === "upload-error") {
            setRecordingStatus(`アップロードエラー: ${message.error || ""}`);
            Alert.alert("エラー", message.error || "アップロードに失敗しました");
          }
        } catch (error) {
          console.error("Error parsing message:", error);
        }
      };

      ws.onerror = (error) => {
        console.error("WebSocket error:", error);
        setRecordingStatus("WebSocketエラー");
        setIsConnected(false);
      };

      ws.onclose = () => {
        console.log("WebSocket closed");
        setIsConnected(false);
        setRecordingStatus("WebSocket切断");
      };
    } catch (error) {
      console.error("Failed to connect WebSocket:", error);
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

      // 定期的に音声データを送信
      sendIntervalRef.current = setInterval(async () => {
        await sendAudioChunk();
      }, SEND_INTERVAL);

      // 最初のチャンクもすぐに送信
      setTimeout(() => {
        sendAudioChunk();
      }, 1000);
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

      // 最後のチャンクを送信
      await sendAudioChunk();

      // 録音を停止
      await audioRecorder.stop();
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

  // 音声チャンクをWebSocket経由で送信
  const sendAudioChunk = async () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.warn("WebSocket is not connected");
      return;
    }

    if (!recorderState.isRecording || isSendingChunkRef.current) {
      return;
    }

    try {
      isSendingChunkRef.current = true;

      // 録音ファイルのURIを取得
      const uri = audioRecorder.uri;
      if (!uri) {
        console.warn("No recording URI");
        return;
      }

      // 録音ファイルの情報を取得
      const fileInfo = await FileSystem.getInfoAsync(uri);
      if (!fileInfo.exists) {
        console.warn("Recording file does not exist");
        return;
      }

      // ファイルサイズを取得
      const currentSize = fileInfo.size || 0;

      // 新しいチャンクがあるかチェック
      if (currentSize <= lastChunkSizeRef.current) {
        console.log("No new audio data");
        return;
      }

      // ファイルをBase64エンコード
      const base64Data = await FileSystem.readAsStringAsync(uri, {
        encoding: "base64",
      });

      // WebSocketメッセージを送信
      const message: WebSocketMessage = {
        action: "upload",
        data: base64Data,
        contentType: "audio/mp4",
        fileName: `recording-${Date.now()}-chunk.m4a`,
      };

      wsRef.current.send(JSON.stringify(message));
      lastChunkSizeRef.current = currentSize;
      console.log(`Audio chunk sent: ${currentSize} bytes`);
    } catch (error) {
      console.error("Failed to send audio chunk:", error);
    } finally {
      isSendingChunkRef.current = false;
    }
  };

  // コンポーネントのアンマウント時にクリーンアップ
  useEffect(() => {
    return () => {
      if (sendIntervalRef.current) {
        clearInterval(sendIntervalRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (recorderState.isRecording) {
        audioRecorder.stop().catch(console.error);
      }
    };
  }, [audioRecorder, recorderState.isRecording]);

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
