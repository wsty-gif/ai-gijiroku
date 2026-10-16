import { llmModel, type LlmChoice } from '../config';
import { resolveLlm } from '../device';
import { markLlmAttempt } from '../storage';
import type { Minutes, Segment, Todo } from '../types';
import { summarizeByRules } from './rules';

export interface SummaryResult {
  title: string;
  summary: string;
  agenda: string[];
  decisions: string[];
  todos: Todo[];
  points: string[];
}

export type SummarizeProgress =
  | { stage: 'load'; ratio: number; downloading: boolean; modelLabel: string }
  | { stage: 'summarize'; done: number; total: number };

export interface SummarizeOutcome {
  minutes: Omit<Minutes, 'datetime' | 'participants'>;
  /** AI要約を使えず簡易要約にしたときの理由 */
  fallbackReason?: string;
}

/** 設定に従って要約する。AIが使えない・失敗したときは簡易要約に切り替える。 */
export async function summarize(
  segments: Segment[],
  choice: LlmChoice,
  onProgress: (p: SummarizeProgress) => void,
): Promise<SummarizeOutcome> {
  const rule = (reason?: string): SummarizeOutcome => ({
    minutes: { ...summarizeByRules(segments), method: 'rule' },
    fallbackReason: reason,
  });

  if (segments.length === 0) return rule();
  const resolved = await resolveLlm(choice);
  if (!resolved) {
    return rule(choice === 'none' ? undefined : 'この端末のブラウザはAI要約（WebGPU）に対応していないため、簡易要約で作成しました。');
  }

  const { loadLlm, summarizeWithLlm } = await import('./llm');
  const label = llmModel(resolved.key).label;
  let engine: Awaited<ReturnType<typeof loadLlm>> | undefined;
  markLlmAttempt(resolved.modelId);
  try {
    engine = await loadLlm(resolved.modelId, (ratio, downloading) =>
      onProgress({ stage: 'load', ratio, downloading, modelLabel: label }),
    );
    const result = await summarizeWithLlm(engine, resolved.modelId, segments, (done, total) =>
      onProgress({ stage: 'summarize', done, total }),
    );
    return { minutes: { ...result, method: 'ai', model: resolved.modelId } };
  } catch (e) {
    console.error(e);
    return rule(`AI要約を実行できなかったため、簡易要約で作成しました（${e instanceof Error ? e.message : String(e)}）。`);
  } finally {
    markLlmAttempt(null);
    await engine?.unload().catch(() => {});
  }
}
