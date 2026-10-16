// マイク音声を約0.1秒ごとにまとめてメインスレッドへ送る AudioWorklet。
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(4096);
    this.length = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
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
