import { keepScreenOn } from '../wakeLock';
import { Resampler } from './resample';

export interface MicOptions {
  /** 使うマイク（未指定なら端末の既定のマイク） */
  deviceId?: string;
  /** ブラウザのノイズ除去・音量自動調整を使うか。専用の会議用マイクやミキサーでは切ると音質が保たれる */
  processing: boolean;
}

export interface MicDevice {
  deviceId: string;
  label: string;
}

/** 使えるマイクの一覧。名前はマイクの使用を一度許可した後でないと取得できない */
export async function listMicrophones(): Promise<MicDevice[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'audioinput' && d.deviceId)
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `マイク ${i + 1}` }));
}

function constraints(opts: MicOptions, exact: boolean): MediaTrackConstraints {
  return {
    ...(opts.deviceId ? { deviceId: exact ? { exact: opts.deviceId } : { ideal: opts.deviceId } } : {}),
    echoCancellation: false,
    noiseSuppression: opts.processing,
    autoGainControl: opts.processing,
  };
}

/**
 * マイク録音。16kHz・モノラルに変換した音声を onAudio に渡す。
 * スマホに挿した外部マイクや、PCにつないだオーディオインターフェース・会議用マイクも使える
 * （2チャンネル以上の機器は全チャンネルを混ぜる）。
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
  private source?: MediaStreamAudioSourceNode;
  private processor?: AudioNode;
  private mute?: GainNode;
  private resampler?: Resampler;
  private releaseScreen?: () => void;
  private paused = false;
  private hiddenAt = 0;
  /** 録音した音声の長さ（16kHz換算のサンプル数） */
  recordedSamples = 0;

  constructor(private options: MicOptions) {}

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
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: constraints(this.options, false) });
    this.resampler = new Resampler(ctx.sampleRate);
    // 出力は無音にして、処理だけ回し続ける
    const mute = ctx.createGain();
    mute.gain.value = 0;
    mute.connect(ctx.destination);
    this.mute = mute;

    if (ctx.audioWorklet) {
      await ctx.audioWorklet.addModule(`${import.meta.env.BASE_URL}recorder-worklet.js`);
      const node = new AudioWorkletNode(ctx, 'recorder');
      node.port.onmessage = (e: MessageEvent<Float32Array>) => this.handle(e.data);
      this.processor = node;
    } else {
      // AudioWorklet 非対応の古いブラウザ向け（先頭チャンネルのみ）
      const node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (e) => this.handle(new Float32Array(e.inputBuffer.getChannelData(0)));
      this.processor = node;
    }
    this.processor.connect(mute);
    this.connectSource();
    if (ctx.state !== 'running') await ctx.resume();
    document.addEventListener('visibilitychange', this.onVisibility);
    this.releaseScreen = keepScreenOn();
  }

  private connectSource() {
    this.source?.disconnect();
    this.source = this.ctx!.createMediaStreamSource(this.stream!);
    this.source.connect(this.processor!);
  }

  /** 使用中のマイクの名前 */
  get deviceLabel(): string {
    return this.stream?.getAudioTracks()[0]?.label ?? '';
  }

  /** 使用中のマイクの deviceId */
  get deviceId(): string | undefined {
    return this.stream?.getAudioTracks()[0]?.getSettings().deviceId;
  }

  /** 録音を止めずにマイクを切り替える */
  async switchDevice(deviceId: string): Promise<void> {
    const next = await navigator.mediaDevices.getUserMedia({
      audio: constraints({ ...this.options, deviceId }, true),
    });
    const prev = this.stream;
    this.stream = next;
    this.options = { ...this.options, deviceId };
    this.connectSource();
    prev?.getTracks().forEach((t) => t.stop());
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
    this.source?.disconnect();
    this.processor?.disconnect();
    this.mute?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close().catch(() => {});
    this.releaseScreen?.();
    this.releaseScreen = undefined;
  }
}
