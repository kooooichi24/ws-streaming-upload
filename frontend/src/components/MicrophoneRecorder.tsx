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

// Server Events
type ServerEvent =
  | { type: 'recording.started'; recordingId: string }
  | { type: 'recording.audio_buffer.committed'; recordingId: string }
  | { type: 'recording.merging_started'; recordingId: string }
  | {
      type: 'error'
      error: {
        type: string
        code: string
        message: string
        eventId: string | null
        params: Record<string, unknown> | null
      }
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
  websocketUrl = 'ws://localhost:3000/realtime',
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
  const [connectionId, setConnectionId] = useState<string | null>(null)
  const [recordingId, setRecordingId] = useState<string | null>(null)

  const audioContextRef = useRef<AudioContext | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const workletNodeRef = useRef<AudioWorkletNode | null>(null)
  const websocketRef = useRef<WebSocket | null>(null)
  const recordingStartTimeRef = useRef<number | null>(null)
  const intervalRef = useRef<number | null>(null)
  const recordingStartedPromiseRef = useRef<{
    resolve: (recordingId: string) => void
    reject: (error: Error) => void
  } | null>(null)
  const recordingIdRef = useRef<string | null>(null)

  // eventIdを生成（UUID v4）
  const generateEventId = (): string => {
    return crypto.randomUUID()
  }

  // サーバーイベントを処理
  const handleServerEvent = (event: ServerEvent) => {
    switch (event.type) {
      case 'recording.started':
        setRecordingId(event.recordingId)
        recordingIdRef.current = event.recordingId
        console.log('録音が開始されました:', event.recordingId)
        // 録音開始のPromiseを解決
        if (recordingStartedPromiseRef.current) {
          recordingStartedPromiseRef.current.resolve(event.recordingId)
          recordingStartedPromiseRef.current = null
        }
        break
      case 'recording.audio_buffer.committed':
        console.log(
          'オーディオバッファがコミットされました:',
          event.recordingId,
        )
        break
      case 'recording.merging_started':
        console.log('録音のマージが開始されました:', event.recordingId)
        break
      case 'error': {
        const errorMessage = event.error.message
        setError(errorMessage)
        console.error('サーバーエラー:', event.error)
        // エラーが発生した場合、録音開始のPromiseを拒否
        if (recordingStartedPromiseRef.current) {
          recordingStartedPromiseRef.current.reject(new Error(errorMessage))
          recordingStartedPromiseRef.current = null
        }
        break
      }
    }
  }

  // WebSocket接続を開始（Promiseを返す）
  const connectWebSocket = (): Promise<void> => {
    return new Promise((resolve, reject) => {
      try {
        setWebsocketStatus('connecting')
        const ws = new WebSocket(websocketUrl)

        // タイムアウトを設定（10秒）
        const timeout = setTimeout(() => {
          reject(new Error('接続確立のタイムアウト'))
        }, 10000)

        ws.onopen = () => {
          console.log('WebSocket接続が開きました')
          setWebsocketStatus('connected')
          clearTimeout(timeout)
          resolve()
        }

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data)
            handleServerEvent(data as ServerEvent)
          } catch (err) {
            console.error('サーバーイベントの解析エラー:', err)
          }
        }

        ws.onerror = (wsError) => {
          setWebsocketStatus('error')
          console.error('WebSocketエラー:', wsError)
          setError('WebSocket接続エラーが発生しました')
          clearTimeout(timeout)
          reject(new Error('WebSocket接続エラーが発生しました'))
        }

        ws.onclose = () => {
          setWebsocketStatus('disconnected')
          setConnectionId(null)
          setRecordingId(null)
          recordingIdRef.current = null
          console.log('WebSocket接続が閉じられました')
          clearTimeout(timeout)
        }

        websocketRef.current = ws
      } catch (err) {
        setWebsocketStatus('error')
        console.error('WebSocket接続エラー:', err)
        setError('WebSocket接続に失敗しました')
        reject(
          err instanceof Error ? err : new Error('WebSocket接続に失敗しました'),
        )
      }
    })
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
      websocketRef.current.readyState === WebSocket.OPEN &&
      recordingIdRef.current !== null
    ) {
      try {
        const base64Data = float32ArrayToBase64(pcmData.data)
        const eventId = generateEventId()
        const message = {
          type: 'recording.audio_buffer.commit',
          eventId,
          audio: base64Data,
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
            (Date.now() - recordingStartTimeRef.current) / 1000,
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

      // WebSocket接続を開始（まだ接続されていない場合）
      if (
        !websocketRef.current ||
        websocketRef.current.readyState !== WebSocket.OPEN
      ) {
        await connectWebSocket()
      }

      // recording.start イベントを送信し、recording.started を待つ
      if (websocketRef.current?.readyState === WebSocket.OPEN) {
        // recording.started を待つPromiseを作成
        const recordingStartedPromise = new Promise<string>(
          (resolve, reject) => {
            recordingStartedPromiseRef.current = { resolve, reject }
            // タイムアウトを設定（10秒）
            setTimeout(() => {
              if (recordingStartedPromiseRef.current) {
                recordingStartedPromiseRef.current.reject(
                  new Error('録音開始のタイムアウト'),
                )
                recordingStartedPromiseRef.current = null
              }
            }, 10000)
          },
        )

        const eventId = generateEventId()
        const startMessage = {
          type: 'recording.start',
          eventId,
        }
        websocketRef.current.send(JSON.stringify(startMessage))
        console.log('録音開始イベントを送信しました:', eventId)

        // recording.started イベントを受信するまで待機
        await recordingStartedPromise
        console.log('録音が開始されました。PCMデータの送信を開始します。')
      } else {
        throw new Error('WebSocket接続が確立されませんでした')
      }

      setIsRecording(true)
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : 'マイクアクセスに失敗しました'
      setError(errorMessage)
      console.error('マイクアクセスエラー:', err)
    }
  }

  const stopRecording = () => {
    // recording.complete イベントを送信
    if (
      websocketRef.current &&
      websocketRef.current.readyState === WebSocket.OPEN &&
      recordingIdRef.current !== null
    ) {
      try {
        const eventId = generateEventId()
        const completeMessage = {
          type: 'recording.complete',
          eventId,
        }
        websocketRef.current.send(JSON.stringify(completeMessage))
        console.log('録音完了イベントを送信しました:', eventId)
      } catch (err) {
        console.error('録音完了イベント送信エラー:', err)
      }
    }

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
    setRecordingId(null)
    recordingIdRef.current = null
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
            {connectionId && <p>接続ID: {connectionId}</p>}
            {recordingId && <p>録音ID: {recordingId}</p>}
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
