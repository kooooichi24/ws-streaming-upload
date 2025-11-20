import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { MicrophoneRecorder } from '../components/MicrophoneRecorder'

export const Route = createFileRoute('/')({ component: App })

interface PCMData {
  data: Float32Array
  sampleRate: number
  timestamp: number
}

function App() {
  const [latestPCMData, setLatestPCMData] = useState<PCMData | null>(null)

  const handlePCMData = (pcmData: PCMData) => {
    setLatestPCMData(pcmData)
  }

  // PCMデータの統計情報を計算
  const getPCMStats = (data: Float32Array) => {
    let sum = 0
    let max = -Infinity
    let min = Infinity
    
    for (const value of data) {
      sum += Math.abs(value)
      max = Math.max(max, value)
      min = Math.min(min, value)
    }
    
    return {
      average: sum / data.length,
      max,
      min,
      length: data.length,
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-slate-800 to-slate-900">
      <section className="py-16 px-6 max-w-4xl mx-auto">
        <div className="text-center mb-8">
          <h2 className="text-4xl font-black text-white mb-4">
            <span className="bg-gradient-to-r from-cyan-400 to-blue-400 bg-clip-text text-transparent">
              マイク音声取得
            </span>
          </h2>
          <p className="text-gray-400">
            AudioWorkletを使用してマイク音声からPCMデータを取得します
          </p>
        </div>

        <div className="space-y-6">
          <MicrophoneRecorder onPCMData={handlePCMData} />

          {latestPCMData && (
            <div className="p-6 bg-slate-800/50 backdrop-blur-sm border border-slate-700 rounded-xl">
              <h3 className="text-xl font-semibold text-white mb-4">
                最新のPCMデータ統計
              </h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                  <p className="text-gray-400 text-sm">サンプル数</p>
                  <p className="text-cyan-400 text-lg font-semibold">
                    {getPCMStats(latestPCMData.data).length}
                  </p>
                </div>
                <div>
                  <p className="text-gray-400 text-sm">平均振幅</p>
                  <p className="text-cyan-400 text-lg font-semibold">
                    {getPCMStats(latestPCMData.data).average.toFixed(6)}
                  </p>
                </div>
                <div>
                  <p className="text-gray-400 text-sm">最大値</p>
                  <p className="text-cyan-400 text-lg font-semibold">
                    {getPCMStats(latestPCMData.data).max.toFixed(6)}
                  </p>
                </div>
                <div>
                  <p className="text-gray-400 text-sm">最小値</p>
                  <p className="text-cyan-400 text-lg font-semibold">
                    {getPCMStats(latestPCMData.data).min.toFixed(6)}
                  </p>
                </div>
              </div>
              <div className="mt-4">
                <p className="text-gray-400 text-sm">サンプルレート</p>
                <p className="text-cyan-400 text-lg font-semibold">
                  {latestPCMData.sampleRate} Hz
                </p>
              </div>
            </div>
          )}

        </div>
      </section>
    </div>
  )
}
