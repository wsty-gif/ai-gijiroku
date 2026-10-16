import { keepScreenOn } from '../wakeLock';
import { Resampler } from './resample';

/**
 * マイク録音。16kHz・モノラルに変換した音声を onAudio に渡す。
 * 画面ロックで止まらないよう Wake Lock で自動ロックを抑止し、
 * 一時的に中断された（別アプリに切り替えた等）場合は復帰時に再開を試みる。
 */
export class MicRecorder {
  onAudio: (samples: Float32Array) => void = () => {};
  /** 音量（0〜1）。レベルメーター表示用 */
  onLevel: (level: number) => void = () => {};
  /** 画面が裏に回った等で録音が途切れた可能性があるとき */
  onInterrupted: () => void = () => {};

  private ctx?: AudioContext;
  private stream?: MediaStream;
  private nodes: AudioNode[] = [];
  private resampler?: Resampler;
  private releaseScreen?: () => void;
  private paused = false;
  private hiddenAt = 0;
  /** 録音した音声の長さ（16kHz換算のサンプル数） */
  recordedSamples = 0;

  private readonly onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      this.hiddenAt = Date.now();
      return;
    }
    if (this.hiddenAt && Date.now() - this.hiddenAt > 1500) this.onInterrupted();
    this.hiddenAt = 0;
    void this.ctx?.resume();
  };

  /** ボタンを押した処理の中から同期的に呼ぶこと（iPhoneは操作直後でないと音声処理を始められない）。 */
  async start(): Promise<void> {
    const ctx = new AudioContext();
    this.ctx = ctx;
    void ctx.resume();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this.resampler = new Resampler(ctx.sampleRate);
    const source = ctx.createMediaStreamSource(this.stream);
    // 出力は無音にして、処理だけ回し続ける
    const mute = ctx.createGain();
    mute.gain.value = 0;
    mute.connect(ctx.destination);

    if (ctx.audioWorklet) {
      await ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}recorder-worklet.js`);
      const node = new AudioWorkletNode(ctx, 'recorder');
      node.port.onmessage = (e: MessageEvent<Float32Array>) => this.handle(e.data);
      source.connect(node);
      node.connect(mute);
      this.nodes = [source, node, mute];
    } else {
      // AudioWorklet 非対応の古いブラウザ向け
      const node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (e) => this.handle(new Float32Array(e.inputBuffer.getChannelData(0)));
      source.connect(node);
      node.connect(mute);
      this.nodes = [source, node, mute];
    }
    if (ctx.state !== 'running') await ctx.resume();
    document.addEventListener('visibilitychange', this.onVisibility);
    this.releaseScreen = keepScreenOn();
  }

  private handle(chunk: Float32Array) {
    if (this.paused || !this.resampler) return;
    let sum = 0;
    for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
    this.onLevel(Math.min(1, Math.sqrt(sum / chunk.length) * 4));
    const samples = this.resampler.process(chunk);
    if (samples.length === 0) return;
    this.recordedSamples += samples.length;
    this.onAudio(samples);
  }

  pause(): void {
    this.paused = true;
    this.onLevel(0);
  }

  resume(): void {
    this.paused = false;
  }

  async stop(): Promise<void> {
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.nodes.forEach((n) => n.disconnect());
    this.nodes = [];
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close();
    this.releaseScreen?.();
    this.releaseScreen = undefined;
  }
}
