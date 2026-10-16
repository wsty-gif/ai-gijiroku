import { SAMPLE_RATE } from '../config';

/**
 * マイクの音声（44.1kHz/48kHz など）を 16kHz に変換する。
 * 出力1サンプルごとに対応する入力区間を平均する（簡易的な低域通過を兼ねる）。
 * 細切れの入力を続けて渡しても、つなぎ目で音が欠けないよう端数を持ち越す。
 */
export class Resampler {
  private readonly ratio: number;
  private carry = new Float32Array(0);

  constructor(inputRate: number) {
    this.ratio = inputRate / SAMPLE_RATE;
  }

  process(input: Float32Array): Float32Array {
    if (this.ratio === 1) return input.slice();
    const buf = new Float32Array(this.carry.length + input.length);
    buf.set(this.carry);
    buf.set(input, this.carry.length);

    const outLength = Math.floor(buf.length / this.ratio);
    const out = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const from = Math.floor(i * this.ratio);
      const to = Math.max(from + 1, Math.floor((i + 1) * this.ratio));
      let sum = 0;
      for (let j = from; j < to; j++) sum += buf[j];
      out[i] = sum / (to - from);
    }
    this.carry = buf.slice(Math.floor(outLength * this.ratio));
    return out;
  }
}
