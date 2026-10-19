import { createStore, del, get, set, values } from 'idb-keyval';
import type { LlmChoice, LlmKey } from './config';
import type { Meeting } from './types';

const meetingStore = createStore('gijiroku', 'meetings');

export async function saveMeeting(m: Meeting): Promise<void> {
  m.updatedAt = Date.now();
  await set(m.id, m, meetingStore);
}

export function loadMeeting(id: string): Promise<Meeting | undefined> {
  return get<Meeting>(id, meetingStore);
}

export async function listMeetings(): Promise<Meeting[]> {
  const all = await values<Meeting>(meetingStore);
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export function deleteMeeting(id: string): Promise<void> {
  return del(id, meetingStore);
}

export function newMeetingId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---- 端末ごとの設定（localStorage は使えない環境もあるので必ず try/catch） ----

const SETTINGS_KEY = 'gijiroku.settings';
/** AI要約の実行記録。正常に終われば消すので、次回起動時に残っていれば途中で止まったことがわかる */
const AI_RUN_KEY = 'gijiroku.aiRun';
/** 旧版の印（読み捨てる） */
const OLD_ATTEMPT_KEY = 'gijiroku.llmAttempt';

export interface Settings {
  llm: LlmChoice;
  /** 前回選んだマイク（つながっていなければ既定のマイクを使う） */
  micDeviceId?: string;
  /** ブラウザのノイズ除去・音量自動調整 */
  audioProcessing: boolean;
}

const DEFAULT_SETTINGS: Settings = { llm: 'auto', audioProcessing: true };

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    // 読めない環境では既定値で動かす
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // 保存できなくても動作は継続する
  }
}

export interface AiRun {
  meetingId: string;
  key: LlmKey;
  modelId: string;
  startedAt: number;
  /** 途中で画面が閉じられた・ロックされた・別アプリに切り替えられたか */
  hidden: boolean;
}

function writeAiRun(run: AiRun | null): void {
  try {
    if (run) localStorage.setItem(AI_RUN_KEY, JSON.stringify(run));
    else localStorage.removeItem(AI_RUN_KEY);
  } catch {
    // 記録できなくても処理は続ける
  }
}

export function startAiRun(run: Omit<AiRun, 'startedAt' | 'hidden'>): void {
  writeAiRun({ ...run, startedAt: Date.now(), hidden: false });
}

export function markAiRunHidden(): void {
  const run = unfinishedAiRun();
  if (run && !run.hidden) writeAiRun({ ...run, hidden: true });
}

export function finishAiRun(): void {
  writeAiRun(null);
}

/** 前回、途中で止まったAI要約の記録（なければ null） */
export function unfinishedAiRun(): AiRun | null {
  try {
    localStorage.removeItem(OLD_ATTEMPT_KEY);
    const raw = localStorage.getItem(AI_RUN_KEY);
    return raw ? (JSON.parse(raw) as AiRun) : null;
  } catch {
    return null;
  }
}
