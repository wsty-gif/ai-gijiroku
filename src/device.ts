import { llmModel, type LlmChoice, type LlmKey } from './config';

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

/** 設定と端末の性能から、使う要約AIを決める。null はAIを使わず簡易要約。 */
export async function resolveLlm(choice: LlmChoice): Promise<{ key: LlmKey; modelId: string } | null> {
  if (choice === 'none') return null;
  const gpu = await detectGpu();
  if (!gpu.webgpu) return null;

  let key: LlmKey;
  if (choice === 'auto') {
    const mem = deviceMemoryGB();
    key = mem !== undefined && mem < 6 ? 'light' : 'standard';
  } else {
    key = choice;
  }
  const model = llmModel(key);
  return { key, modelId: gpu.shaderF16 ? model.idF16 : model.idF32 };
}
