import { lighterChoice, llmModel, type LlmChoice, type LlmEngine } from '../config';
import { detectGpu, resolveLlm, resolveModel, type ResolvedLlm } from '../device';
import { finishAiRun, loadSettings, markAiRunHidden, saveSettings, startAiRun } from '../storage';
import type { Minutes, Segment, Todo } from '../types';
import { SummaryAbortedError, type AskProgress, type LlmBackend } from './backend';
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
  | { stage: 'load'; ratio: number; downloading: boolean; modelLabel: string; engine: LlmEngine }
  | { stage: 'summarize'; done: number; total: number; ask?: AskProgress; modelLabel: string; engine: LlmEngine };

export interface SummarizeOutcome {
  minutes: Omit<Minutes, 'datetime' | 'participants'>;
  /** AI要約を使えず簡易要約にしたとき・軽い設定に切り替えたときの説明 */
  note?: string;
}

/** メモリや保存容量が足りずに失敗したか（軽いモデルなら成功する見込みがある） */
function isResourceError(e: unknown): boolean {
  const text = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /out of memory|OOM|alloc|device.?lost|GPUDevice|maxBufferSize|maxStorageBuffer|quota|memory access out of bounds|Array buffer allocation|Aborted\(/i.test(
    text,
  );
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function engineLabel(engine: LlmEngine): string {
  return engine === 'webgpu' ? 'GPU' : 'CPU';
}

async function loadBackend(r: ResolvedLlm, onProgress: (ratio: number, downloading: boolean) => void): Promise<LlmBackend> {
  if (r.engine === 'webgpu') {
    const { createWebLlmBackend } = await import('./webllmBackend');
    return createWebLlmBackend(r.modelId, r.contextWindow, onProgress);
  }
  const { createWllamaBackend } = await import('./wllamaBackend');
  return createWllamaBackend(r.modelId, r.contextWindow, /qwen/i.test(r.modelId), onProgress);
}

/**
 * 設定に従って要約する。
 * メモリ・容量不足で失敗したときは、ひとつ軽いモデルで自動的にやり直し（GPUで全滅したらCPUでも試し）、
 * 成功した設定を保存する。AIが使えない・すべて失敗したときは簡易要約にする。
 */
export async function summarize(
  meetingId: string,
  segments: Segment[],
  choice: LlmChoice,
  onProgress: (p: SummarizeProgress) => void,
  signal?: AbortSignal,
): Promise<SummarizeOutcome> {
  const rule = (note?: string): SummarizeOutcome => ({
    minutes: { ...summarizeByRules(segments), method: 'rule' },
    note,
  });

  if (segments.length === 0) return rule();
  let resolved: ResolvedLlm | null = await resolveLlm(choice);
  if (!resolved) {
    return rule(choice === 'none' ? undefined : 'この端末のブラウザではAI要約を使えないため、簡易要約で作成しました。');
  }

  const { summarizeWithLlm } = await import('./llm');
  const first = resolved;
  const gpu = await detectGpu();

  // 画面のロックや別アプリへの切り替えで止まった場合に、次回「メモリ不足」と誤って伝えないよう記録する
  const onHidden = () => {
    if (document.visibilityState === 'hidden') markAiRunHidden();
  };
  document.addEventListener('visibilitychange', onHidden);
  window.addEventListener('pagehide', markAiRunHidden);

  try {
    while (resolved) {
      const current: ResolvedLlm = resolved;
      const { engine, key, modelId, contextWindow } = current;
      const label = `${llmModel(key).label}・${engineLabel(engine)}`;
      let backend: LlmBackend | undefined;
      startAiRun({ meetingId, key, modelId });
      try {
        const loading = loadBackend(current, (ratio, downloading) =>
          onProgress({ stage: 'load', ratio, downloading, modelLabel: label, engine }),
        );
        // 読み込み（初回はダウンロード）の途中でも、やめるボタンですぐ簡易要約に切り替えられるようにする
        const aborted = new Promise<never>((_, reject) => {
          if (signal?.aborted) reject(new SummaryAbortedError());
          signal?.addEventListener('abort', () => reject(new SummaryAbortedError()), { once: true });
        });
        backend = await Promise.race([loading, aborted]).catch((e) => {
          if (e instanceof SummaryAbortedError) void loading.then((b) => b.unload()).catch(() => {});
          throw e;
        });
        const result = await summarizeWithLlm(
          backend,
          contextWindow,
          segments,
          (done, total, ask) => onProgress({ stage: 'summarize', done, total, ask, modelLabel: label, engine }),
          { todoPass: key === 'high', signal },
        );
        const switched = current.key !== first.key || current.engine !== first.engine;
        if (switched && current.engine === first.engine) saveSettings({ ...loadSettings(), llm: key });
        return {
          minutes: { ...result, method: 'ai', model: modelId.split('/').pop() },
          note: switched
            ? `「${llmModel(first.key).label}」ではブラウザのメモリ上限を超えたため、「${label}」で作成しました（設定で変更できます）。`
            : undefined,
        };
      } catch (e) {
        await backend?.unload().catch(() => {});
        backend = undefined;
        if (e instanceof SummaryAbortedError || signal?.aborted) {
          return rule('AI要約を途中でやめ、簡易要約で作成しました（「要約を作り直す」でAI要約をやり直せます）。');
        }
        console.error(e);
        if (!isResourceError(e)) {
          return rule(`AI要約を実行できなかったため、簡易要約で作成しました（${errorText(e)}）。`);
        }
        const next = lighterChoice(key);
        if (next !== 'none') resolved = resolveModel(engine, next, gpu.shaderF16);
        // GPUで標準モデルも駄目なら、CPUで試す（遅いがGPUのメモリ上限に左右されない）
        else if (engine === 'webgpu') resolved = resolveModel('cpu', 'standard', gpu.shaderF16);
        else {
          return rule(`ブラウザが使えるメモリ・保存容量の上限を超えたため、簡易要約で作成しました（${errorText(e)}）。`);
        }
      } finally {
        await backend?.unload().catch(() => {});
      }
    }
    return rule();
  } finally {
    document.removeEventListener('visibilitychange', onHidden);
    window.removeEventListener('pagehide', markAiRunHidden);
    finishAiRun();
  }
}
