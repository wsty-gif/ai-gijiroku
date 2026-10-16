import { lighterChoice, llmModel, type LlmChoice } from '../config';
import { resolveLlm, type ResolvedLlm } from '../device';
import { finishAiRun, loadSettings, markAiRunHidden, saveSettings, startAiRun } from '../storage';
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
  | { stage: 'summarize'; done: number; total: number; modelLabel: string };

export interface SummarizeOutcome {
  minutes: Omit<Minutes, 'datetime' | 'participants'>;
  /** AI要約を使えず簡易要約にしたとき・軽い設定に切り替えたときの説明 */
  note?: string;
}

/** メモリや保存容量が足りずに失敗したか（軽いモデルなら成功する見込みがある） */
function isResourceError(e: unknown): boolean {
  const text = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /out of memory|OOM|alloc|device.?lost|GPUDevice|maxBufferSize|maxStorageBuffer|quota/i.test(text);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 設定に従って要約する。
 * メモリ・容量不足で失敗したときは、ひとつ軽いモデルで自動的にやり直し、成功した設定を保存する。
 * AIが使えない・すべて失敗したときは簡易要約にする。
 */
export async function summarize(
  meetingId: string,
  segments: Segment[],
  choice: LlmChoice,
  onProgress: (p: SummarizeProgress) => void,
): Promise<SummarizeOutcome> {
  const rule = (note?: string): SummarizeOutcome => ({
    minutes: { ...summarizeByRules(segments), method: 'rule' },
    note,
  });

  if (segments.length === 0) return rule();
  let resolved: ResolvedLlm | null = await resolveLlm(choice);
  if (!resolved) {
    return rule(choice === 'none' ? undefined : 'この端末のブラウザはAI要約（WebGPU）に対応していないため、簡易要約で作成しました。');
  }

  const { loadLlm, summarizeWithLlm } = await import('./llm');
  const firstLabel = llmModel(resolved.key).label;

  // 画面のロックや別アプリへの切り替えで止まった場合に、次回「メモリ不足」と誤って伝えないよう記録する
  const onHidden = () => {
    if (document.visibilityState === 'hidden') markAiRunHidden();
  };
  document.addEventListener('visibilitychange', onHidden);
  window.addEventListener('pagehide', markAiRunHidden);

  try {
    while (resolved) {
      const { key, modelId, contextWindow } = resolved;
      const label = llmModel(key).label;
      let engine: Awaited<ReturnType<typeof loadLlm>> | undefined;
      startAiRun({ meetingId, key, modelId });
      try {
        engine = await loadLlm(modelId, contextWindow, (ratio, downloading) =>
          onProgress({ stage: 'load', ratio, downloading, modelLabel: label }),
        );
        const result = await summarizeWithLlm(engine, modelId, contextWindow, segments, (done, total) =>
          onProgress({ stage: 'summarize', done, total, modelLabel: label }),
        );
        const switched = label !== firstLabel;
        if (switched) saveSettings({ ...loadSettings(), llm: key });
        return {
          minutes: { ...result, method: 'ai', model: modelId },
          note: switched
            ? `「${firstLabel}」ではブラウザのメモリ上限を超えたため、「${label}」で作成しました（以後は「${label}」を使います。設定で変更できます）。`
            : undefined,
        };
      } catch (e) {
        console.error(e);
        await engine?.unload().catch(() => {});
        engine = undefined;
        const next = lighterChoice(key);
        if (!isResourceError(e) || next === 'none') {
          return rule(
            isResourceError(e)
              ? `ブラウザが使えるメモリ・保存容量の上限を超えたため、簡易要約で作成しました（${errorText(e)}）。`
              : `AI要約を実行できなかったため、簡易要約で作成しました（${errorText(e)}）。`,
          );
        }
        resolved = await resolveLlm(next);
      } finally {
        await engine?.unload().catch(() => {});
      }
    }
    return rule();
  } finally {
    document.removeEventListener('visibilitychange', onHidden);
    window.removeEventListener('pagehide', markAiRunHidden);
    finishAiRun();
  }
}
