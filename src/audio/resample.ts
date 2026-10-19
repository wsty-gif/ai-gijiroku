import { SAMPLE_RATE } from '../config';

/** 端数位置の分解能。この細かさで重みを前計算しておく */
const PHASES = 256;
/** フィルタの片側の長さ（遮断周波数の周期でいくつ分か）。大きいほど急峻で重い */
const ZERO_CROSSINGS = 8;

function sinc(t: number): number {
  if (t === 0) return 1;
  const x = Math.PI * t;
  return Math.sin(x) / x;
}

/**
 * マイクの音声（44.1kHz/48kHz など）を 16kHz に変換する。
 * 窓関数付き sinc の低域通過フィルタで帯域を 7.2kHz までに絞ってから間引くので、
 * 高い音（「さ」「し」の擦れる音など）が低い帯域に折り返して雑音になるのを防ぐ。
 * 細切れの入力を続けて渡しても、つなぎ目で音が欠けないよう前後のサンプルを持ち越す。
 */
export class Resampler {
  private readonly step: number;
  private readonly half: number;
  private readonly table: Float32Array[];
  private buf: Float32Array;
  /** 次に出力するサンプルの位置（buf 上の入力サンプル単位、端数あり） */
  private pos: number;

  constructor(inputRate: number, outputRate = SAMPLE_RATE) {
    this.step = inputRate / outputRate;
    const fc = (0.45 * Math.min(inputRate, outputRate)) / inputRate;
    this.half = Math.ceil(ZERO_CROSSINGS / (2 * fc));
    // 端数位置ごとの重み。合計が1になるよう正規化して音量を保つ
    this.table = [];
    for (let p = 0; p < PHASES; p++) {
      const frac = p / PHASES;
      const w = new Float32Array(2 * this.half);
      let sum = 0;
      for (let j = 0; j < w.length; j++) {
        const x = j - this.half + 1 - frac;
        const u = x / this.half;
        const blackman = Math.abs(u) >= 1 ? 0 : 0.42 + 0.5 * Math.cos(Math.PI * u) + 0.08 * Math.cos(2 * Math.PI * u);
        w[j] = sinc(2 * fc * x) * blackman;
        sum += w[j];
      }
      for (let j = 0; j < w.length; j++) w[j] /= sum;
      this.table.push(w);
    }
    // 録音開始前は無音とみなす
    this.buf = new Float32Array(this.half);
    this.pos = this.half;
  }

  process(input: Float32Array): Float32Array {
    if (this.step === 1) return input.slice();
    const b = new Float32Array(this.buf.length + input.length);
    b.set(this.buf);
    b.set(input, this.buf.length);

    // 右側に half+1 サンプル先まで揃っている位置だけ計算する
    const count = Math.max(0, Math.floor((b.length - 2 - this.half - this.pos) / this.step) + 1);
    const out = new Float32Array(count);
    let pos = this.pos;
    for (let i = 0; i < count; i++, pos += this.step) {
      let base = Math.floor(pos);
      let phase = Math.round((pos - base) * PHASES);
      if (phase === PHASES) {
        phase = 0;
        base += 1;
      }
      const w = this.table[phase];
      const start = base - this.half + 1;
      let acc = 0;
      for (let j = 0; j < w.length; j++) acc += b[start + j] * w[j];
      out[i] = acc;
    }
    // 次の計算に必要な分だけ残す
    const drop = Math.max(0, Math.floor(pos) - this.half);
    this.buf = b.slice(drop);
    this.pos = pos - drop;
    return out;
  }
}
