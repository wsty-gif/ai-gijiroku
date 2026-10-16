import type { Segment, Todo } from '../types';

/** 文字起こしを、要約AIに一度に渡せる長さの塊に分ける（発話の途中では切らない）。 */
export function chunkTranscript(segments: Segment[], maxChars: number): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const seg of segments) {
    const line = seg.text.trim();
    if (!line) continue;
    if (current && current.length + line.length + 1 > maxChars) {
      chunks.push(current);
      current = '';
    }
    current += (current ? '\n' : '') + line;
  }
  if (current) chunks.push(current);
  return chunks;
}

function normalize(s: string): string {
  return s.replace(/[\s、。，．,.!！?？・「」『』（）()]/g, '').toLowerCase();
}

/** 同じ内容・ほぼ同じ内容の項目を取り除く（後に出てきた短い方を捨てる）。 */
export function dedupe(items: string[]): string[] {
  const kept: { raw: string; norm: string }[] = [];
  for (const raw of items.map((s) => s.trim()).filter(Boolean)) {
    const norm = normalize(raw);
    if (!norm) continue;
    const dup = kept.findIndex((k) => k.norm.includes(norm) || norm.includes(k.norm));
    if (dup === -1) kept.push({ raw, norm });
    else if (norm.length > kept[dup].norm.length) kept[dup] = { raw, norm };
  }
  return kept.map((k) => k.raw);
}

export function dedupeTodos(todos: Todo[]): Todo[] {
  const tasks = dedupe(todos.map((t) => t.task));
  return tasks.map((task) => todos.find((t) => t.task.trim() === task)!).filter(Boolean);
}

export function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatDuration(sec: number): string {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}時間${m}分` : m > 0 ? `${m}分${r}秒` : `${r}秒`;
}
