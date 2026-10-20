import { LLM_CONTEXT, llmModel, type LlmChoice, type LlmEngine, type LlmKey } from './config';

export interface GpuInfo {
  webgpu: boolean;
  shaderF16: boolean;
}

let cached: Promise<GpuInfo> | null = null;

/** ブラウザ上でAIを動かすためのGPU機能（WebGPU）が使えるか調べる。 */
export function detectGpu(): Promise<GpuInfo> {
  cached ??= (async () => {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<GpuAdapterLike | null> } }).gpu;
    if (!gpu) return { webgpu: false, shaderF16: false };
    try {
      const adapter = await gpu.requestAdapter();
      if (!adapter) return { webgpu: false, shaderF16: false };
      return { webgpu: true, shaderF16: adapter.features.has('shader-f16') };
    } catch {
      return { webgpu: false, shaderF16: false };
    }
  })();
  return cached;
}

interface GpuAdapterLike {
  features: { has(name: string): boolean };
}

/** 端末のメモリ量（GB）。Android の Chrome 系のみ取得でき、iPhone では undefined。 */
function deviceMemoryGB(): number | undefined {
  return (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
}

/** スマホ・タブレットか（iPadOS は Mac と名乗るのでタッチ対応で見分ける） */
export function isMobileDevice(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod|Android|Mobile/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

export interface ResolvedLlm {
  engine: LlmEngine;
  key: LlmKey;
  /** GPU版は WebLLM のモデルID、CPU版は GGUF の URL */
  modelId: string;
  contextWindow: number;
}

function wasmSupported(): boolean {
  return typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function';
}

/** 要約AIをGPUで動かすか、CPUで動かすか（どちらも使えなければ null） */
export async function llmEngine(): Promise<LlmEngine | null> {
  const gpu = await detectGpu();
  return gpu.webgpu ? 'webgpu' : wasmSupported() ? 'cpu' : null;
}

/** 設定と端末の性能から、使う要約AIを決める。null はAIを使わず簡易要約。 */
export async function resolveLlm(choice: LlmChoice): Promise<ResolvedLlm | null> {
  if (choice === 'none') return null;
  const engine = await llmEngine();
  if (!engine) return null;
  const gpu = await detectGpu();

  let key: LlmKey;
  if (choice === 'auto') {
    // GPUのあるPCでは高精度、それ以外（スマホ・GPUなし）は標準
    const mem = deviceMemoryGB();
    key = engine === 'webgpu' && !isMobileDevice() && (mem === undefined || mem >= 8) ? 'high' : 'standard';
  } else {
    key = choice;
  }
  return resolveModel(engine, key, gpu.shaderF16);
}

/** エンジンとモデルの組み合わせから、実際に読み込むモデルを決める */
export function resolveModel(engine: LlmEngine, key: LlmKey, shaderF16: boolean): ResolvedLlm {
  // CPU では重すぎるモデル（高精度）は標準にする
  if (engine === 'cpu' && !llmModel(key).cpu) key = 'standard';
  const model = llmModel(key);
  return engine === 'webgpu'
    ? { engine, key, modelId: shaderF16 ? model.webgpu.idF16 : model.webgpu.idF32, contextWindow: LLM_CONTEXT }
    : { engine, key, modelId: model.cpu!.url, contextWindow: LLM_CONTEXT };
}
