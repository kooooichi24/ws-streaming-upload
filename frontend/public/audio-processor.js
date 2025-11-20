// AudioWorkletプロセッサー: PCMデータを処理してメインスレッドに送信
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.bufferSize = 4096 // バッファサイズ
    this.buffer = new Float32Array(this.bufferSize)
    this.bufferIndex = 0
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0]
    
    // 入力チャンネルが存在する場合
    if (input && input.length > 0) {
      const inputChannel = input[0]
      
      // 入力データをバッファに追加
      for (let i = 0; i < inputChannel.length; i++) {
        this.buffer[this.bufferIndex] = inputChannel[i]
        this.bufferIndex++
        
        // バッファが満杯になったらメインスレッドに送信
        if (this.bufferIndex >= this.bufferSize) {
          // Float32Arrayをコピーして送信（共有メモリを避けるため）
          const pcmData = new Float32Array(this.buffer)
          this.port.postMessage({
            type: 'pcm-data',
            data: pcmData,
            sampleRate: sampleRate,
          })
          this.bufferIndex = 0
        }
      }
    }
    
    // プロセッサーを継続実行
    return true
  }
}

// AudioWorkletProcessorを登録
registerProcessor('pcm-processor', PCMProcessor)

