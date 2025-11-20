import { useEffect, useRef, useState } from 'react'

interface PCMData {
  data: Float32Array
  sampleRate: number
  timestamp: number
}

interface MicrophoneRecorderProps {
  onPCMData?: (pcmData: PCMData) => void
  bufferSize?: number
}

export function MicrophoneRecorder({
  onPCMData,
  bufferSize = 4096,
}: MicrophoneRecorderProps) {
  const [isRecording, setIsRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [audioContext, setAudioContext] = useState<AudioContext | null>(null)
  const [sampleRate, setSampleRate] = useState<number | null>(null)
  const [pcmDataCount, setPcmDataCount] = useState(0)
  
  const audioContextRef = useRef<AudioContext | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const workletNodeRef = useRef<AudioWorkletNode | null>(null)

  // AudioWorkletのセットアップ
  useEffect(() => {
    return () => {
      // クリーンアップ
      stopRecording()
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
      setAudioContext(context)
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
        }
      }

      // マイク入力をAudioWorkletNodeに接続
      const source = context.createMediaStreamSource(stream)
      source.connect(workletNode)

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
      setAudioContext(null)
    }

    setIsRecording(false)
    setPcmDataCount(0)
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
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 bg-red-500 rounded-full animate-pulse"></div>
              <span className="text-white">録音中...</span>
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

