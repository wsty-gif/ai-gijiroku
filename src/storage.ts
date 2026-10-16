import { createStore, del, get, set, values } from 'idb-keyval';
import type { LlmChoice } from './config';
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
/** AI要約の途中でアプリが落ちたかを次回起動時に判定するための印 */
const LLM_ATTEMPT_KEY = 'gijiroku.llmAttempt';

export interface Settings {
  llm: LlmChoice;
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { llm: 'auto', ...JSON.parse(raw) };
  } catch {
    // 読めない環境では既定値で動かす
  }
  return { llm: 'auto' };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // 保存できなくても動作は継続する
  }
}

export function markLlmAttempt(modelId: string | null): void {
  try {
    if (modelId) localStorage.setItem(LLM_ATTEMPT_KEY, modelId);
    else localStorage.removeItem(LLM_ATTEMPT_KEY);
  } catch {
    // 無視
  }
}

export function lastUnfinishedLlmAttempt(): string | null {
  try {
    return localStorage.getItem(LLM_ATTEMPT_KEY);
  } catch {
    return null;
  }
}
