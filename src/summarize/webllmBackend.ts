import type { InitProgressReport } from '@mlc-ai/web-llm';
import { parseJson, SummaryAbortedError, type AskProgress, type LlmBackend, type LoadProgress } from './backend';

/** WebGPU（GPU）で動かす。速いが WebGPU 対応のブラウザでしか使えない。 */
export async function createWebLlmBackend(modelId: string, contextWindow: number, onProgress: LoadProgress): Promise<LlmBackend> {
  const webllm = await import('@mlc-ai/web-llm');
  const engine = await webllm.CreateMLCEngine(
    modelId,
    { initProgressCallback: (r: InitProgressReport) => onProgress(r.progress, /fetch/i.test(r.text)) },
    // 扱う長さを短くすると、その分の作業用メモリ（KVキャッシュ）が減る
    { context_window_size: contextWindow },
  );
  return {
    slow: false,
    async askJson<T>(
      prompt: string,
      schema: object,
      maxTokens: number,
      _onAsk?: (p: AskProgress) => void,
      signal?: AbortSignal,
    ): Promise<T> {
      // GPU版は速いので、進み具合は知らせず結果をまとめて受け取る
      const stop = () => engine.interruptGenerate();
      signal?.addEventListener('abort', stop);
      try {
        const res = await engine.chat.completions.create({
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2,
          max_tokens: maxTokens,
          response_format: { type: 'json_object', schema: JSON.stringify(schema) },
          // Qwen系は「考える」出力を挟むので止める（他のモデルに付けると出力が崩れる）
          ...(modelId.startsWith('Qwen') ? { extra_body: { enable_thinking: false } } : {}),
        });
        if (signal?.aborted) throw new SummaryAbortedError();
        return parseJson<T>(res.choices[0]?.message?.content ?? '');
      } finally {
        signal?.removeEventListener('abort', stop);
        await engine.resetChat().catch(() => {});
      }
    },
    unload: () => engine.unload(),
  };
}
