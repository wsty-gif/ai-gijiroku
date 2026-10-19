// マイク音声を約0.1秒ごとにまとめてメインスレッドへ送る AudioWorklet。
// 2チャンネル以上の機器（オーディオインターフェースやミキサー）では全チャンネルを混ぜる。
// （マイクが2番目の入力につながっていても無音にならないように）
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(4096);
    this.length = 0;
  }

  process(inputs) {
    const channels = inputs[0] || [];
    let channel = channels[0];
    if (channels.length > 1) {
      channel = new Float32Array(channels[0].length);
      for (const ch of channels) {
        for (let i = 0; i < ch.length; i++) channel[i] += ch[i];
      }
      for (let i = 0; i < channel.length; i++) channel[i] /= channels.length;
    }
    if (channel) {
      let offset = 0;
      while (offset < channel.length) {
        const n = Math.min(channel.length - offset, this.buffer.length - this.length);
        this.buffer.set(channel.subarray(offset, offset + n), this.length);
        this.length += n;
        offset += n;
        if (this.length === this.buffer.length) {
          this.port.postMessage(this.buffer);
          this.buffer = new Float32Array(4096);
          this.length = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('recorder', RecorderProcessor);
