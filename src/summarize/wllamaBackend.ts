import type { CacheManager } from '@wllama/wllama';
import { parseJson, SummaryAbortedError, type AskProgress, type LlmBackend, type LoadProgress } from './backend';

/** 保存済みのモデルが、途中までしか保存されていないか */
async function isIncompleteDownload(cache: CacheManager, url: string): Promise<boolean> {
  try {
    const name = await cache.getNameFromURL(url);
    const [size, meta] = await Promise.all([cache.getSize(name), cache.getMetadata(name)]);
    return !!meta && meta.originalSize > 0 && size !== meta.originalSize;
  } catch {
    return false;
  }
}

/**
 * CPUで動かす（wllama = llama.cpp の WebAssembly 版）。
 * GPU（WebGPU）がない端末でもAI要約できるようにするためのもの。GPUより遅いので軽いモデルを使う。
 * モデル（GGUF）は初回にダウンロードして端末に保存し、2回目以降はオフラインでも使える。
 */
export async function createWllamaBackend(
  ggufUrl: string,
  contextWindow: number,
  isQwen: boolean,
  onProgress: LoadProgress,
): Promise<LlmBackend> {
  const [{ Wllama }, { default: wasmUrl }] = await Promise.all([
    import('@wllama/wllama'),
    import('@wllama/wllama/esm/wasm/wllama.wasm?url'),
  ]);
  // 大きなモデルを保存するので、ブラウザに「容量が苦しくなっても消さない」保存を頼む
  await navigator.storage?.persist?.().catch(() => false);
  let wllama = new Wllama({ default: wasmUrl }, { suppressNativeLog: true, allowOffline: true });
  const load = (w: InstanceType<typeof Wllama>) =>
    w.loadModelFromUrl(ggufUrl, {
      n_ctx: contextWindow,
      // GPUは使わない（GPUが使える端末では WebLLM を使う）
      n_gpu_layers: 0,
      // 注意: jinja: true を付けると会話テンプレートの処理で強制終了する（wllama 3.8.1）。
      // 付けなくても chat_template_kwargs（Qwen の「考える」出力を止める指定）は効く。
      progressCallback: ({ loaded, total }: { loaded: number; total: number }) =>
        onProgress(total > 0 ? loaded / total : 0, true),
    });
  try {
    await load(wllama);
  } catch (e) {
    // ダウンロードが途中で切れて、保存済みのモデルが元の大きさと違うときだけ、消して取り直す
    // （それ以外の失敗で取り直すと、1GB以上を無駄にダウンロードしてしまうため）
    if (!(await isIncompleteDownload(wllama.cacheManager, ggufUrl))) throw e;
    console.warn('cached model is incomplete; re-downloading', e);
    await wllama.exit().catch(() => {});
    await wllama.cacheManager.delete(ggufUrl).catch(() => {});
    wllama = new Wllama({ default: wasmUrl }, { suppressNativeLog: true, allowOffline: true });
    await load(wllama);
  }
  onProgress(1, false);
  return {
    slow: true,
    async askJson<T>(
      prompt: string,
      schema: object,
      maxTokens: number,
      onAsk?: (p: AskProgress) => void,
      signal?: AbortSignal,
    ): Promise<T> {
      // 少しずつ受け取り、読み込みの進み具合と書き進めた量を画面に知らせる
      let text = '';
      try {
        await wllama.createChatCompletion({
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2,
          max_tokens: maxTokens,
          response_format: { type: 'json_schema', json_schema: { name: 'minutes', schema } },
          ...(isQwen ? { chat_template_kwargs: { enable_thinking: false } } : {}),
          stream: true,
          return_progress: true,
          abortSignal: signal,
          onData: (chunk) => {
            const pp = (chunk as { prompt_progress?: { total: number; processed: number; time_ms: number } }).prompt_progress;
            if (pp && pp.total > 0 && !text) {
              const rate = pp.processed > 0 ? pp.time_ms / pp.processed : 0;
              onAsk?.({
                phase: 'reading',
                ratio: pp.processed / pp.total,
                remainingSec: rate > 0 ? ((pp.total - pp.processed) * rate) / 1000 : undefined,
              });
            }
            const delta = chunk.choices[0]?.delta?.content ?? '';
            if (delta) {
              text += delta;
              onAsk?.({ phase: 'writing', chars: text.length });
            }
          },
        });
      } catch (e) {
        if (signal?.aborted) throw new SummaryAbortedError();
        throw e;
      }
      if (signal?.aborted) throw new SummaryAbortedError();
      return parseJson<T>(text);
    },
    unload: () => wllama.exit(),
  };
}
