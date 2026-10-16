import type { InitProgressReport, MLCEngine } from '@mlc-ai/web-llm';
import type { Segment, Todo } from '../types';
import { summarizeByRules } from './rules';
import { chunkTranscript, dedupe, dedupeTodos } from './text';
import type { SummaryResult } from './index';

/**
 * 要約AI（WebLLM）による議事録作成。
 * ブラウザで動くモデルは一度に扱える長さ（2,048〜4,096トークン）が短いため、
 *   1) 文字起こしを塊に分け、塊ごとに「議題・要点・決定事項・ToDo」を抜き出す
 *   2) 抜き出した結果をまとめ、タイトルと概要を作る
 * の2段階で処理する。
 */

interface Budget {
  /** 1つの塊の文字数。日本語は1文字≒1トークン弱なので、指示文と出力の分を残す */
  chunkChars: number;
  chunkTokens: number;
  finalTokens: number;
  /** 最後のまとめに渡す各項目の合計文字数の上限 */
  topicsChars: number;
  pointsChars: number;
  decisionsChars: number;
}

function budgetFor(contextWindow: number): Budget {
  return contextWindow >= 4096
    ? { chunkChars: 1400, chunkTokens: 700, finalTokens: 600, topicsChars: 300, pointsChars: 1200, decisionsChars: 500 }
    : { chunkChars: 700, chunkTokens: 450, finalTokens: 400, topicsChars: 150, pointsChars: 550, decisionsChars: 250 };
}

function isContextOverflow(e: unknown): boolean {
  return e instanceof Error && /ContextWindow|context window/i.test(e.name + e.message);
}

const CHUNK_SCHEMA = {
  type: 'object',
  properties: {
    topics: { type: 'array', items: { type: 'string' } },
    points: { type: 'array', items: { type: 'string' } },
    decisions: { type: 'array', items: { type: 'string' } },
    todos: {
      type: 'array',
      items: {
        type: 'object',
        properties: { task: { type: 'string' }, owner: { type: 'string' }, due: { type: 'string' } },
        required: ['task', 'owner', 'due'],
      },
    },
  },
  required: ['topics', 'points', 'decisions', 'todos'],
};

const FINAL_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    agenda: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'summary', 'agenda'],
};

interface ChunkResult {
  topics: string[];
  points: string[];
  decisions: string[];
  todos: Todo[];
}

interface FinalResult {
  title: string;
  summary: string;
  agenda: string[];
}

export async function loadLlm(
  modelId: string,
  contextWindow: number,
  onProgress: (ratio: number, downloading: boolean) => void,
): Promise<MLCEngine> {
  const webllm = await import('@mlc-ai/web-llm');
  return webllm.CreateMLCEngine(
    modelId,
    { initProgressCallback: (r: InitProgressReport) => onProgress(r.progress, /fetch/i.test(r.text)) },
    // 扱う長さを短くすると、その分の作業用メモリ（KVキャッシュ）が減る
    { context_window_size: contextWindow },
  );
}

function chunkPrompt(text: string): string {
  return `あなたは会議の議事録係です。以下は会議の文字起こしの一部です（音声認識のため誤字や句読点の欠落があります）。
この部分から議事録に必要な情報を抜き出し、JSONで出力してください。

- topics: 話し合われた議題・話題（短い言葉で、最大3件）
- points: 主な発言や議論の要点（1件1文で簡潔に、最大5件）
- decisions: はっきり決まった事項（決まっていないものは入れない）
- todos: 誰かがやると決まった作業。task=作業内容、owner=担当者（不明なら空文字）、due=期限（不明なら空文字）

該当がなければ空の配列にしてください。文字起こしに無いことは書かないでください。

文字起こし:
"""
${text}
"""`;
}

function finalPrompt(topics: string[], points: string[], decisions: string[]): string {
  const list = (items: string[]) => (items.length ? items.map((s) => `- ${s}`).join('\n') : '（なし）');
  return `あなたは会議の議事録係です。以下は会議全体から抜き出した情報です。
これをもとに、議事録のタイトル・概要・議題を作り、JSONで出力してください。

- title: 会議の内容がわかる短いタイトル（20文字程度）
- summary: 会議全体の概要（3〜5文の自然な日本語）
- agenda: 議題の一覧（似たものはまとめて、最大6件）

話題:
${list(topics)}

要点:
${list(points)}

決定事項:
${list(decisions)}`;
}

function parseJson<T>(text: string): T {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('AIの出力を読み取れませんでした');
    return JSON.parse(match[0]) as T;
  }
}

async function askJson<T>(engine: MLCEngine, modelId: string, prompt: string, schema: object, maxTokens: number): Promise<T> {
  const res = await engine.chat.completions.create({
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.2,
    max_tokens: maxTokens,
    response_format: { type: 'json_object', schema: JSON.stringify(schema) },
    // Qwen系は「考える」出力を挟むので止める（他のモデルに付けると出力が崩れる）
    ...(modelId.startsWith('Qwen') ? { extra_body: { enable_thinking: false } } : {}),
  });
  await engine.resetChat();
  return parseJson<T>(res.choices[0]?.message?.content ?? '');
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim()) : [];
}

function todosOf(v: unknown): Todo[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object' && typeof t.task === 'string' && t.task.trim() !== '')
    .map((t) => ({
      task: String(t.task).trim(),
      owner: typeof t.owner === 'string' ? t.owner.trim() : '',
      due: typeof t.due === 'string' ? t.due.trim() : '',
    }));
}

/** 塊1つを処理する。長すぎて入らなかったときは半分に割って再挑戦し、それでも駄目なら簡易要約で補う。 */
async function summarizeChunk(
  engine: MLCEngine,
  modelId: string,
  budget: Budget,
  text: string,
  depth = 0,
): Promise<ChunkResult> {
  try {
    const r = await askJson<Partial<ChunkResult>>(engine, modelId, chunkPrompt(text), CHUNK_SCHEMA, budget.chunkTokens);
    return { topics: strings(r.topics), points: strings(r.points), decisions: strings(r.decisions), todos: todosOf(r.todos) };
  } catch (e) {
    await engine.resetChat().catch(() => {});
    if (isContextOverflow(e) && depth < 2 && text.length > 200) {
      const mid = text.lastIndexOf('\n', text.length / 2) > 0 ? text.lastIndexOf('\n', text.length / 2) : Math.floor(text.length / 2);
      const a = await summarizeChunk(engine, modelId, budget, text.slice(0, mid), depth + 1);
      const b = await summarizeChunk(engine, modelId, budget, text.slice(mid), depth + 1);
      return {
        topics: [...a.topics, ...b.topics],
        points: [...a.points, ...b.points],
        decisions: [...a.decisions, ...b.decisions],
        todos: [...a.todos, ...b.todos],
      };
    }
    console.warn('chunk summarize failed; falling back to rules', e);
    const r = summarizeByRules([{ start: 0, end: 0, text }]);
    return { topics: r.agenda, points: r.points, decisions: r.decisions, todos: r.todos };
  }
}

/** 項目が多すぎると最後のまとめに入りきらないので、均等に間引き、それでも長ければ後ろを削る。 */
function fit(items: string[], maxChars: number): string[] {
  let out = items;
  while (out.length > 4 && out.join('').length > maxChars) out = out.filter((_, i) => i % 2 === 0);
  while (out.length > 1 && out.join('').length > maxChars) out = out.slice(0, -1);
  return out;
}

export async function summarizeWithLlm(
  engine: MLCEngine,
  modelId: string,
  contextWindow: number,
  segments: Segment[],
  onProgress: (done: number, total: number) => void,
): Promise<SummaryResult> {
  const budget = budgetFor(contextWindow);
  const chunks = chunkTranscript(segments, budget.chunkChars);
  const total = chunks.length + 1;
  const all: ChunkResult = { topics: [], points: [], decisions: [], todos: [] };
  for (const [i, chunk] of chunks.entries()) {
    onProgress(i, total);
    const r = await summarizeChunk(engine, modelId, budget, chunk);
    all.topics.push(...r.topics);
    all.points.push(...r.points);
    all.decisions.push(...r.decisions);
    all.todos.push(...r.todos);
  }
  onProgress(chunks.length, total);

  const topics = dedupe(all.topics);
  const points = dedupe(all.points);
  const decisions = dedupe(all.decisions);
  const todos = dedupeTodos(all.todos);

  let final: FinalResult = { title: topics[0] ?? '会議', summary: '', agenda: topics.slice(0, 6) };
  // 入りきらなかったときは、渡す量を半分ずつ減らしてやり直す
  for (const scale of [1, 0.5, 0.25]) {
    try {
      const prompt = finalPrompt(
        fit(topics, budget.topicsChars * scale),
        fit(points, budget.pointsChars * scale),
        fit(decisions, budget.decisionsChars * scale),
      );
      const r = await askJson<Partial<FinalResult>>(engine, modelId, prompt, FINAL_SCHEMA, budget.finalTokens);
      final = {
        title: typeof r.title === 'string' && r.title.trim() ? r.title.trim() : final.title,
        summary: typeof r.summary === 'string' ? r.summary.trim() : '',
        agenda: strings(r.agenda),
      };
      break;
    } catch (e) {
      console.warn('final summarize failed', e);
      await engine.resetChat().catch(() => {});
      if (!isContextOverflow(e)) break;
    }
  }
  onProgress(total, total);

  return {
    title: final.title,
    summary: final.summary,
    agenda: final.agenda.length ? final.agenda : topics.slice(0, 6),
    decisions,
    todos,
    points,
  };
}
