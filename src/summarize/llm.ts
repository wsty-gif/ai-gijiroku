import type { Segment, Todo } from '../types';
import { SummaryAbortedError, type AskProgress, type LlmBackend } from './backend';
import type { SummaryResult } from './index';
import { hintLines, summarizeByRules } from './rules';
import { chunkTranscript, dedupe, dedupeTodos } from './text';

/**
 * 要約AIによる議事録作成（GPU版・CPU版で共通の手順）。
 * 実際の会議音声で試した結果、会議全体を1回でAIに渡した方が「誰が何を頼んだか」を取り違えにくいので、
 *  - 入りきる長さ（約1万字 ≒ 40分程度の会話）なら、1回で議事録全体を作る
 *  - それより長ければ、塊ごとに決定事項・宿題・要点を抜き出し、最後にまとめる
 * の2通りで処理する。
 */

/** 1回でAIに渡す文字数の上限。Qwen3.5 は日本語1文字が約0.25〜0.35トークンなので、8,192トークン中に収まる */
const MAX_CHARS_PER_CALL = 10000;

interface Budget {
  chunkChars: number;
  /** 1回の出力の上限（トークン）。出力は入力より時間がかかるので、要点は短く書かせる */
  fullTokens: number;
  chunkTokens: number;
  finalTokens: number;
  /** 最後のまとめに渡す各項目の合計文字数の上限 */
  topicsChars: number;
  pointsChars: number;
  decisionsChars: number;
}

function budgetFor(contextWindow: number): Budget {
  if (contextWindow >= 8192) {
    return { chunkChars: MAX_CHARS_PER_CALL, fullTokens: 1400, chunkTokens: 1000, finalTokens: 700, topicsChars: 600, pointsChars: 3000, decisionsChars: 1500 };
  }
  return { chunkChars: 4000, fullTokens: 1200, chunkTokens: 900, finalTokens: 600, topicsChars: 300, pointsChars: 1200, decisionsChars: 500 };
}

function isContextOverflow(e: unknown): boolean {
  const text = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /ContextWindow|context window|context size|kv_cache_full|exceeds? the context/i.test(text);
}

const TODO_ITEM = {
  type: 'object',
  properties: { task: { type: 'string' }, owner: { type: 'string' }, due: { type: 'string' } },
  required: ['task', 'owner', 'due'],
};
const STRING_LIST = { type: 'array', items: { type: 'string' } };

const FULL_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    agenda: STRING_LIST,
    decisions: STRING_LIST,
    todos: { type: 'array', items: TODO_ITEM },
    points: STRING_LIST,
  },
  required: ['title', 'summary', 'agenda', 'decisions', 'todos', 'points'],
};

const CHUNK_SCHEMA = {
  type: 'object',
  properties: { topics: STRING_LIST, decisions: STRING_LIST, todos: { type: 'array', items: TODO_ITEM }, points: STRING_LIST },
  required: ['topics', 'decisions', 'todos', 'points'],
};

const FINAL_SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string' }, summary: { type: 'string' }, agenda: STRING_LIST },
  required: ['title', 'summary', 'agenda'],
};

/** 決定事項・宿題・要点の書き方（全体版と分割版で共通） */
const ITEM_RULES = `- decisions: この会議で新たに決まったこと。「〜にしましょう」「〜で進めてください」などで合意・指示された内容だけ。進捗の報告や、提案されただけで決まらなかったことは入れない。
- todos: この会議で新たに頼まれた・引き受けた宿題。「〇〇さん〜してください」「〜しておいてくれるかな」と頼まれたことや「〜しておきます」と引き受けたこと。いま進めている作業の報告は入れない。task=やること（短く）、owner=担当する人の名前、due=期限
- points: 報告・議論の要点（1件1文で短く。誰の報告か分かれば最後に（名前）を付ける）`;

const CAUTIONS = `【注意】
- 音声認識で作った文字起こしなので、句読点と話者名がなく、同じ音の別の言葉への誤変換があります。文脈から正しく理解し、誤変換と思われる言葉は正しい言葉に直してください。
- 時刻と時間の長さを区別してください（例: 「十時から三十分間」は「10:00から30分間」）。
- 文字起こしに無いことは書かないでください。分からない項目は空文字にしてください。`;

/** 決定・依頼・引き受けの可能性がある発言を目印として添える（小さいAIの見落としを減らす） */
function hintSection(text: string): string {
  const hints = hintLines(text.split('\n'));
  if (hints.length === 0) return '';
  return `【参考】決定・依頼・引き受けの可能性がある発言（前後の発言つき）。決定事項と宿題を漏らさないよう、特にこれらを確認してください。担当者は、頼まれた人・引き受けた人です。
${hints.join('\n')}

`;
}

/** concise: CPU版など遅いときは、書く量（＝待ち時間）を減らすため概要・要点を短めにする */
function fullPrompt(text: string, concise: boolean): string {
  return `あなたは優秀な議事録係です。以下の会議の文字起こしから議事録を作り、JSONで出力してください。

- title: 会議名（20文字以内）
- summary: 会議全体の概要（${concise ? '2〜3文' : '3文程度'}）
- agenda: 議題（最大${concise ? 4 : 5}件、短く）
${ITEM_RULES}（points は最大${concise ? '4件、1件40文字以内' : '6件'}）

${CAUTIONS}

${hintSection(text)}文字起こし:
"""
${text}
"""`;
}

function chunkPrompt(text: string): string {
  return `あなたは優秀な議事録係です。以下は会議の文字起こしの一部です。議事録に必要な情報を抜き出し、JSONで出力してください。

- topics: 話し合われた議題（短く、最大3件）
${ITEM_RULES}（points は最大5件）

${CAUTIONS}

${hintSection(text)}文字起こし:
"""
${text}
"""`;
}

const TODO_SCHEMA = { type: 'object', properties: { todos: { type: 'array', items: TODO_ITEM } }, required: ['todos'] };

/**
 * 宿題だけを別に尋ねる指示文。話者名のない文字起こしでは担当者を取り違えやすいので、
 * 「頼まれた人・引き受けた人」の見分け方を詳しく伝えて、宿題に集中させる。
 */
function todoPrompt(text: string): string {
  const hints = hintLines(text.split('\n'));
  return `以下は会議の文字起こしです（音声認識のため句読点・話者名がなく、誤変換があります）。
この会議で新たに割り当てられた宿題（誰かがやることになった作業）をすべて抜き出し、JSONで出力してください。

- task: やること（短く。誤変換は正しい言葉に直す）
- owner: 担当する人の名前。依頼された人、または自分から引き受けた人です。「〇〇さん〜してください」「〇〇さん〜しておいてくれるかな」なら〇〇さん。質問や依頼をされた人が「〜します」と答えた場合は、その答えた人（＝質問・依頼された人）です。
- due: 期限（「明日まで」「来週から」など。なければ空文字）

【入れないもの】
- 進捗の報告（「〜を実施中です」「今週中に完了する予定です」など、もともと進めている作業）
- その会議に出ていない人（不在の人）への割り当て

【参考】依頼・引き受けの可能性がある発言（前後の発言つき）:
${hints.length ? hints.join('\n') : '（なし）'}

文字起こし:
"""
${text}
"""`;
}

/** 宿題だけを別に抜き出す。失敗したら null（元の結果を使う） */
async function extractTodos(backend: LlmBackend, text: string): Promise<Todo[] | null> {
  try {
    const r = await backend.askJson<{ todos?: unknown }>(todoPrompt(text), TODO_SCHEMA, 600);
    return todosOf(r.todos);
  } catch (e) {
    if (e instanceof SummaryAbortedError) throw e;
    console.warn('todo pass failed', e);
    return null;
  }
}

function finalPrompt(topics: string[], points: string[], decisions: string[]): string {
  const list = (items: string[]) => (items.length ? items.map((s) => `- ${s}`).join('\n') : '（なし）');
  return `あなたは優秀な議事録係です。以下は会議全体から抜き出した情報です。
これをもとに、議事録の会議名・概要・議題を作り、JSONで出力してください。

- title: 会議名（20文字以内）
- summary: 会議全体の概要（3〜5文の自然な日本語）
- agenda: 議題の一覧（似たものはまとめて、最大6件）

話題:
${list(topics)}

要点:
${list(points)}

決定事項:
${list(decisions)}`;
}

interface ChunkResult {
  topics: string[];
  points: string[];
  decisions: string[];
  todos: Todo[];
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim()) : [];
}

/** 「不明」「なし」などは空欄として扱う */
const NONE = /^(不明|なし|無し|未定|不明確|特になし|該当なし|-|—|ー|n\/?a|none|null|unknown)$/i;

function field(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  return NONE.test(s) ? '' : s.replace(/さん$/, '');
}

function todosOf(v: unknown): Todo[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object' && typeof t.task === 'string' && t.task.trim() !== '')
    .map((t) => ({ task: String(t.task).trim(), owner: field(t.owner), due: field(t.due) }));
}

/** 塊1つを処理する。長すぎて入らなかったときは半分に割って再挑戦し、それでも駄目なら簡易要約で補う。 */
async function summarizeChunk(
  backend: LlmBackend,
  budget: Budget,
  todoPass: boolean,
  text: string,
  onAsk?: (p: AskProgress) => void,
  depth = 0,
): Promise<ChunkResult> {
  try {
    const r = await backend.askJson<Partial<ChunkResult>>(chunkPrompt(text), CHUNK_SCHEMA, budget.chunkTokens, onAsk);
    const todos = (todoPass ? await extractTodos(backend, text) : null) ?? todosOf(r.todos);
    return { topics: strings(r.topics), points: strings(r.points), decisions: strings(r.decisions), todos };
  } catch (e) {
    if (e instanceof SummaryAbortedError) throw e;
    if (isContextOverflow(e) && depth < 2 && text.length > 200) {
      const mid = text.lastIndexOf('\n', text.length / 2) > 0 ? text.lastIndexOf('\n', text.length / 2) : Math.floor(text.length / 2);
      const a = await summarizeChunk(backend, budget, todoPass, text.slice(0, mid), onAsk, depth + 1);
      const b = await summarizeChunk(backend, budget, todoPass, text.slice(mid), onAsk, depth + 1);
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

/** 会議全体を1回で議事録にする。入りきらなければ null（分割処理に切り替える） */
async function summarizeWhole(
  backend: LlmBackend,
  budget: Budget,
  todoPass: boolean,
  text: string,
  onAsk: (p: AskProgress) => void,
  onHalfway: () => void,
): Promise<SummaryResult | null> {
  try {
    const tokens = backend.slow ? Math.min(budget.fullTokens, 900) : budget.fullTokens;
    const r = await backend.askJson<Record<string, unknown>>(fullPrompt(text, backend.slow), FULL_SCHEMA, tokens, onAsk);
    onHalfway();
    const title = typeof r.title === 'string' ? r.title.trim() : '';
    const todos = (todoPass ? await extractTodos(backend, text) : null) ?? todosOf(r.todos);
    return {
      title: title || '会議',
      summary: typeof r.summary === 'string' ? r.summary.trim() : '',
      agenda: strings(r.agenda),
      decisions: dedupe(strings(r.decisions)),
      todos: dedupeTodos(todos),
      points: dedupe(strings(r.points)),
    };
  } catch (e) {
    if (isContextOverflow(e)) return null;
    throw e;
  }
}

/**
 * todoPass: 宿題だけを別にもう一度尋ねるか。4B では担当者の取り違えが減ったが、
 * 2B では逆に進捗報告まで宿題に入れてしまったため、大きいモデルのときだけ使う。
 */
export async function summarizeWithLlm(
  backend: LlmBackend,
  contextWindow: number,
  segments: Segment[],
  onProgress: (done: number, total: number, ask?: AskProgress) => void,
  { todoPass = false, signal }: { todoPass?: boolean; signal?: AbortSignal } = {},
): Promise<SummaryResult> {
  // 途中でやめられるよう、すべての問い合わせに signal を付ける
  const original = backend;
  backend = {
    ...original,
    askJson: (prompt, schema, maxTokens, onAsk) => original.askJson(prompt, schema, maxTokens, onAsk, signal),
  };
  const budget = budgetFor(contextWindow);
  const whole = segments.map((s) => s.text.trim()).filter(Boolean).join('\n');

  if (whole.length <= budget.chunkChars) {
    const steps = todoPass ? 2 : 1;
    onProgress(0, steps);
    const r = await summarizeWhole(
      backend,
      budget,
      todoPass,
      whole,
      (p) => onProgress(0, steps, p),
      () => onProgress(1, steps),
    );
    if (r) {
      onProgress(steps, steps);
      return cleanTodos(r, whole);
    }
  }

  const chunks = chunkTranscript(segments, budget.chunkChars);
  const total = chunks.length + 1;
  const all: ChunkResult = { topics: [], points: [], decisions: [], todos: [] };
  for (const [i, chunk] of chunks.entries()) {
    onProgress(i, total);
    const r = await summarizeChunk(backend, budget, todoPass, chunk, (p) => onProgress(i, total, p));
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

  let final = { title: topics[0] ?? '会議', summary: '', agenda: topics.slice(0, 6) };
  // 入りきらなかったときは、渡す量を半分ずつ減らしてやり直す
  for (const scale of [1, 0.5, 0.25]) {
    try {
      const prompt = finalPrompt(
        fit(topics, budget.topicsChars * scale),
        fit(points, budget.pointsChars * scale),
        fit(decisions, budget.decisionsChars * scale),
      );
      const r = await backend.askJson<Record<string, unknown>>(prompt, FINAL_SCHEMA, budget.finalTokens);
      final = {
        title: typeof r.title === 'string' && r.title.trim() ? r.title.trim() : final.title,
        summary: typeof r.summary === 'string' ? r.summary.trim() : '',
        agenda: strings(r.agenda),
      };
      break;
    } catch (e) {
      if (e instanceof SummaryAbortedError) throw e;
      console.warn('final summarize failed', e);
      if (!isContextOverflow(e)) break;
    }
  }
  onProgress(total, total);

  return cleanTodos(
    {
      title: final.title,
      summary: final.summary,
      agenda: final.agenda.length ? final.agenda : topics.slice(0, 6),
      decisions,
      todos,
      points,
    },
    whole,
  );
}

/** 進捗の報告（「〜を実施中」など）は宿題ではないので外す */
const PROGRESS_REPORT = /(実施中|設計中|作業中|進行中|対応中|進捗報告|の報告$|を報告$)/;

/**
 * AIが出した宿題から明らかな誤りを除く。
 *  - 「〇〇さんは研修のため不在」のように不在とわかる人は担当者にしない
 *  - 進捗の報告は宿題から外す
 */
function cleanTodos(r: SummaryResult, transcript: string): SummaryResult {
  const absent = new Set<string>();
  for (const m of transcript.matchAll(/([一-龥々ァ-ヶー]{1,4})さん(?:が|は)[^\n]{0,15}?(?:不在|欠席|お休み|休み)/g)) absent.add(m[1]);
  const todos = r.todos
    .filter((t) => !PROGRESS_REPORT.test(t.task))
    .map((t) => (absent.has(t.owner) ? { ...t, owner: '' } : t));
  return { ...r, todos };
}
