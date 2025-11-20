import { useEffect, useRef, useState } from 'react'

interface PCMData {
  data: Float32Array
  sampleRate: number
  timestamp: number
}

interface MicrophoneRecorderProps {
  onPCMData?: (pcmData: PCMData) => void
  bufferSize?: number
  websocketUrl?: string
}

// Float32Arrayをbase64にエンコード
function float32ArrayToBase64(float32Array: Float32Array): string {
  // Float32ArrayをInt16Arrayに変換（16bit PCM）
  const int16Array = new Int16Array(float32Array.length)
  for (let i = 0; i < float32Array.length; i++) {
    // -1.0 ～ 1.0 の範囲を -32768 ～ 32767 に変換
    const sample = Math.max(-1, Math.min(1, float32Array[i]))
    int16Array[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
  }
  
  // Int16ArrayをUint8Arrayに変換
  const uint8Array = new Uint8Array(int16Array.buffer)
  
  // base64にエンコード
  let binary = ''
  for (const byte of uint8Array) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

export function MicrophoneRecorder({
  onPCMData,
  bufferSize = 4096,
  websocketUrl = 'wss://xhx738yp6f.execute-api.ap-northeast-1.amazonaws.com/dev',
}: MicrophoneRecorderProps) {
  const [isRecording, setIsRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sampleRate, setSampleRate] = useState<number | null>(null)
  const [pcmDataCount, setPcmDataCount] = useState(0)
  const [websocketStatus, setWebsocketStatus] = useState<
    'disconnected' | 'connecting' | 'connected' | 'error'
  >('disconnected')
  const [sentDataCount, setSentDataCount] = useState(0)
  const [recordingTime, setRecordingTime] = useState(0) // 録音時間（秒）
  
  const audioContextRef = useRef<AudioContext | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const workletNodeRef = useRef<AudioWorkletNode | null>(null)
  const websocketRef = useRef<WebSocket | null>(null)
  const recordingStartTimeRef = useRef<number | null>(null)
  const intervalRef = useRef<number | null>(null)

  // WebSocket接続を開始
  const connectWebSocket = () => {
    try {
      setWebsocketStatus('connecting')
      const ws = new WebSocket(websocketUrl)
      
      ws.onopen = () => {
        setWebsocketStatus('connected')
        console.log('WebSocket接続が開きました')
      }
      
      ws.onerror = (wsError) => {
        setWebsocketStatus('error')
        console.error('WebSocketエラー:', wsError)
        setError('WebSocket接続エラーが発生しました')
      }
      
      ws.onclose = () => {
        setWebsocketStatus('disconnected')
        console.log('WebSocket接続が閉じられました')
      }
      
      websocketRef.current = ws
    } catch (err) {
      setWebsocketStatus('error')
      console.error('WebSocket接続エラー:', err)
      setError('WebSocket接続に失敗しました')
    }
  }

  // WebSocket接続を閉じる
  const disconnectWebSocket = () => {
    if (websocketRef.current) {
      websocketRef.current.close()
      websocketRef.current = null
      setWebsocketStatus('disconnected')
    }
  }

  // PCMデータをWebSocketで送信
  const sendPCMDataToWebSocket = (pcmData: PCMData) => {
    if (
      websocketRef.current &&
      websocketRef.current.readyState === WebSocket.OPEN
    ) {
      try {
        const base64Data = float32ArrayToBase64(pcmData.data)
        const message = {
          action: 'upload',
          data: base64Data,
          contentType: 'audio/pcm',
        }
        websocketRef.current.send(JSON.stringify(message))
        setSentDataCount((prev) => prev + 1)
      } catch (err) {
        console.error('PCMデータ送信エラー:', err)
      }
    }
  }

  // 録音時間をフォーマット（MM:SS形式）
  const formatRecordingTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }

  // 録音時間の更新（録音中のみ）
  useEffect(() => {
    if (isRecording) {
      recordingStartTimeRef.current = Date.now()
      setRecordingTime(0)
      
      // 100msごとに録音時間を更新
      intervalRef.current = window.setInterval(() => {
        if (recordingStartTimeRef.current) {
          const elapsed = Math.floor(
            (Date.now() - recordingStartTimeRef.current) / 1000
          )
          setRecordingTime(elapsed)
        }
      }, 100)
    } else {
      // 録音停止時にタイマーをクリア
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
      recordingStartTimeRef.current = null
      setRecordingTime(0)
    }

    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current)
      }
    }
  }, [isRecording])

  // AudioWorkletのセットアップ
  useEffect(() => {
    return () => {
      // クリーンアップ
      stopRecording()
      disconnectWebSocket()
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current)
      }
    }
  }, [])

  const startRecording = async () => {
    try {
      setError(null)
      
      // マイクアクセスを要求
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1, // モノラル
          sampleRate: 24000, // サンプルレート
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      })
      
      mediaStreamRef.current = stream

      // AudioContextを作成
      const context = new AudioContext({
        sampleRate: 24000,
      })
      audioContextRef.current = context
      setSampleRate(context.sampleRate)

      // AudioWorkletをロード
      await context.audioWorklet.addModule('/audio-processor.js')

      // AudioWorkletNodeを作成
      const workletNode = new AudioWorkletNode(context, 'pcm-processor')
      workletNodeRef.current = workletNode

      // PCMデータを受信
      workletNode.port.onmessage = (event) => {
        if (event.data.type === 'pcm-data') {
          const pcmData: PCMData = {
            data: event.data.data,
            sampleRate: event.data.sampleRate,
            timestamp: Date.now(),
          }
          setPcmDataCount((prev) => prev + 1)
          onPCMData?.(pcmData)
          
          // WebSocketで送信
          sendPCMDataToWebSocket(pcmData)
        }
      }

      // マイク入力をAudioWorkletNodeに接続
      const source = context.createMediaStreamSource(stream)
      source.connect(workletNode)

      // WebSocket接続を開始
      connectWebSocket()

      setIsRecording(true)
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : 'マイクアクセスに失敗しました'
      setError(errorMessage)
      console.error('マイクアクセスエラー:', err)
    }
  }

  const stopRecording = () => {
    if (workletNodeRef.current) {
      workletNodeRef.current.disconnect()
      workletNodeRef.current = null
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop())
      mediaStreamRef.current = null
    }

    if (audioContextRef.current) {
      audioContextRef.current.close()
      audioContextRef.current = null
    }

    // WebSocket接続を閉じる
    disconnectWebSocket()

    setIsRecording(false)
    setPcmDataCount(0)
    setSentDataCount(0)
  }

  const toggleRecording = () => {
    if (isRecording) {
      stopRecording()
    } else {
      startRecording()
    }
  }

  return (
    <div className="p-6 bg-slate-800/50 backdrop-blur-sm border border-slate-700 rounded-xl">
      <h2 className="text-2xl font-semibold text-white mb-4">
        マイク音声取得 (AudioWorklet)
      </h2>

      <div className="space-y-4">
        <div className="flex items-center gap-4">
          <button
            onClick={toggleRecording}
            className={`px-6 py-3 rounded-lg font-semibold transition-colors ${
              isRecording
                ? 'bg-red-500 hover:bg-red-600 text-white'
                : 'bg-cyan-500 hover:bg-cyan-600 text-white'
            }`}
          >
            {isRecording ? '停止' : '録音開始'}
          </button>

          {isRecording && (
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse"></div>
                <span className="text-white">録音中...</span>
              </div>
              <div className="text-cyan-400 font-mono text-lg font-semibold">
                {formatRecordingTime(recordingTime)}
              </div>
            </div>
          )}
        </div>

        {error && (
          <div className="p-4 bg-red-900/50 border border-red-700 rounded-lg">
            <p className="text-red-300">{error}</p>
          </div>
        )}

        {sampleRate && (
          <div className="text-gray-300">
            <p>サンプルレート: {sampleRate} Hz</p>
            <p>バッファサイズ: {bufferSize} サンプル</p>
            <p>受信したPCMデータ数: {pcmDataCount}</p>
            <p>送信したPCMデータ数: {sentDataCount}</p>
          </div>
        )}

        {isRecording && (
          <div className="text-gray-300">
            <p>
              WebSocket状態:{' '}
              <span
                className={
                  websocketStatus === 'connected'
                    ? 'text-green-400'
                    : websocketStatus === 'connecting'
                      ? 'text-yellow-400'
                      : websocketStatus === 'error'
                        ? 'text-red-400'
                        : 'text-gray-400'
                }
              >
                {websocketStatus === 'disconnected'
                  ? '切断'
                  : websocketStatus === 'connecting'
                    ? '接続中...'
                    : websocketStatus === 'connected'
                      ? '接続済み'
                      : 'エラー'}
              </span>
            </p>
          </div>
        )}

        <div className="text-sm text-gray-400">
          <p>AudioWorkletを使用してマイク音声からPCMデータを取得します。</p>
          <p>PCMデータはonPCMDataコールバックで受け取ることができます。</p>
        </div>
      </div>
    </div>
  )
}

