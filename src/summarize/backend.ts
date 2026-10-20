/**
 * 要約AIの実行エンジンの共通の窓口。
 *  - webgpu: WebLLM（GPUで高速。WebGPU対応のブラウザのみ）
 *  - cpu:    wllama（llama.cpp をブラウザで動かす。GPUがなくてもどの端末でも動くが遅め）
 * どちらも同じ指示文・同じ手順で要約するので、エンジンが違っても結果の傾向は同じになる。
 */

/** AIの処理の進み具合（CPU版は時間がかかるので、止まっていないことと残り時間を画面に出す） */
export type AskProgress =
  | { phase: 'reading'; ratio: number; remainingSec?: number }
  | { phase: 'writing'; chars: number };

export interface LlmBackend {
  /** 指示文を渡し、JSON（schema の形）で答えを受け取る。signal で途中でやめられる */
  askJson<T>(
    prompt: string,
    schema: object,
    maxTokens: number,
    onProgress?: (p: AskProgress) => void,
    signal?: AbortSignal,
  ): Promise<T>;
  unload(): Promise<void>;
  /** 遅いエンジン（CPU）か。遅いときは出力を短めにして待ち時間を減らす */
  slow: boolean;
}

export type LoadProgress = (ratio: number, downloading: boolean) => void;

export class SummaryAbortedError extends Error {
  constructor() {
    super('要約を途中でやめました');
    this.name = 'SummaryAbortedError';
  }
}

/** AIの出力からJSONを取り出す（考えた過程の <think> や前後の余計な文字は除く） */
export function parseJson<T>(text: string): T {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('AIの出力を読み取れませんでした');
    return JSON.parse(match[0]) as T;
  }
}
