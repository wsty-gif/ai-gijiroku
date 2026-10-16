import { ASR_MODEL, SAMPLE_RATE } from '../config';
import type { Segment } from '../types';
import { asrModelUrls } from './modelCache';

type WorkerMessage =
  | { type: 'ready' }
  | { type: 'segment'; start: number; end: number; text: string }
  | { type: 'processed'; samples: number }
  | { type: 'flushed' }
  | { type: 'error'; message: string };

/** 文字起こしワーカーの窓口。16kHz・モノラルの音声を渡すと、区切りごとに文字起こし結果が返る。 */
export class AsrEngine {
  onSegment: (seg: Segment) => void = () => {};
  onError: (message: string) => void = () => {};

  private sentSamples = 0;
  private processedSamples = 0;
  private flushWaiters: (() => void)[] = [];
  private progressWaiters: (() => void)[] = [];

  private constructor(private worker: Worker) {}

  /** ワーカーを起動し、端末に保存済みの日本語モデルを読み込む。 */
  static create(): Promise<AsrEngine> {
    const worker = new Worker(`${import.meta.env.BASE_URL}asr-worker.js`);
    const engine = new AsrEngine(worker);
    return new Promise((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
        if (e.data.type === 'ready') {
          worker.onmessage = (ev: MessageEvent<WorkerMessage>) => engine.handle(ev.data);
          resolve(engine);
        } else if (e.data.type === 'error') {
          worker.terminate();
          reject(new Error(e.data.message));
        }
      };
      worker.onerror = (e) => {
        worker.terminate();
        reject(new Error(e.message || '文字起こしエンジンを起動できませんでした'));
      };
      worker.postMessage({ type: 'init', urls: asrModelUrls(), cacheName: ASR_MODEL.cacheName });
    });
  }

  private handle(msg: WorkerMessage) {
    switch (msg.type) {
      case 'segment':
        this.onSegment({ start: msg.start, end: msg.end, text: msg.text });
        break;
      case 'processed':
        this.processedSamples = msg.samples;
        this.progressWaiters.splice(0).forEach((fn) => fn());
        break;
      case 'flushed':
        this.flushWaiters.splice(0).forEach((fn) => fn());
        break;
      case 'error':
        this.onError(msg.message);
        break;
    }
  }

  /** 音声を渡す（渡した配列は使えなくなる）。 */
  push(samples: Float32Array): void {
    this.sentSamples += samples.length;
    this.worker.postMessage({ type: 'audio', samples }, [samples.buffer]);
  }

  /** まだ文字起こしが終わっていない音声の長さ（秒） */
  get backlogSeconds(): number {
    return (this.sentSamples - this.processedSamples) / SAMPLE_RATE;
  }

  /** 処理待ちが指定秒数を下回るまで待つ（ファイル読み込み時に渡しすぎないため）。 */
  async waitForBacklogBelow(seconds: number): Promise<void> {
    while (this.backlogSeconds > seconds) {
      await new Promise<void>((resolve) => this.progressWaiters.push(resolve));
    }
  }

  /** 渡した音声をすべて文字起こしし終えるまで待つ。 */
  flush(): Promise<void> {
    return new Promise((resolve) => {
      this.flushWaiters.push(resolve);
      this.worker.postMessage({ type: 'flush' });
    });
  }

  reset(): void {
    this.sentSamples = 0;
    this.processedSamples = 0;
    this.worker.postMessage({ type: 'reset' });
  }

  dispose(): void {
    this.worker.terminate();
  }
}
