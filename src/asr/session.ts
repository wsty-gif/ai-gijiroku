import { SAMPLE_RATE } from '../config';
import { saveMeeting } from '../storage';
import type { Meeting, Segment } from '../types';
import { AsrEngine } from './asrEngine';

/**
 * 1回の会議の文字起こし。エンジンの起動中に届いた音声は溜めておき、起動後にまとめて渡す。
 * 文字起こし結果は届くたびに会議データへ追記し、数秒おきに端末へ保存する（途中で落ちても残る）。
 */
export class TranscriptionSession {
  onSegment: (seg: Segment) => void = () => {};
  onError: (message: string) => void = () => {};

  private engine?: AsrEngine;
  private readonly ready: Promise<AsrEngine>;
  private pending: Float32Array[] = [];
  private pendingSamples = 0;
  private saveTimer?: number;

  constructor(readonly meeting: Meeting) {
    this.ready = AsrEngine.create().then((engine) => {
      engine.onSegment = (seg) => this.addSegment(seg);
      engine.onError = (m) => this.onError(m);
      for (const p of this.pending) engine.push(p);
      this.pending = [];
      this.pendingSamples = 0;
      this.engine = engine;
      return engine;
    });
    // 起動失敗は呼び出し側が whenReady / finish で受け取る
    this.ready.catch(() => {});
  }

  whenReady(): Promise<AsrEngine> {
    return this.ready;
  }

  get isReady(): boolean {
    return !!this.engine;
  }

  push(samples: Float32Array): void {
    if (this.engine) {
      this.engine.push(samples);
    } else {
      this.pending.push(samples);
      this.pendingSamples += samples.length;
    }
  }

  /** まだ文字起こしされていない音声の長さ（秒） */
  get backlogSeconds(): number {
    return this.engine ? this.engine.backlogSeconds : this.pendingSamples / SAMPLE_RATE;
  }

  async waitForBacklogBelow(seconds: number): Promise<void> {
    const engine = await this.ready;
    await engine.waitForBacklogBelow(seconds);
  }

  private addSegment(seg: Segment) {
    this.meeting.segments.push(seg);
    this.onSegment(seg);
    if (this.saveTimer === undefined) {
      this.saveTimer = window.setTimeout(() => {
        this.saveTimer = undefined;
        void saveMeeting(this.meeting);
      }, 3000);
    }
  }

  async save(): Promise<void> {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    await saveMeeting(this.meeting);
  }

  /** 残りの音声をすべて文字起こしして保存し、エンジンを止めてメモリを空ける。 */
  async finish(): Promise<Meeting> {
    const engine = await this.ready;
    await engine.flush();
    engine.dispose();
    this.engine = undefined;
    await this.save();
    return this.meeting;
  }

  /** 保存せずに止める（キャンセル時） */
  dispose(): void {
    clearTimeout(this.saveTimer);
    this.engine?.dispose();
    this.ready.then((e) => e.dispose()).catch(() => {});
  }
}
