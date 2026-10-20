// 使用するAIモデルの定義。モデルを差し替えるときはこのファイルだけを変更する。

/** 文字起こしモデル: ReazonSpeech k2 v2（日本語特化, Apache-2.0）の int8 版。コミット固定。 */
export const ASR_MODEL = {
  name: 'ReazonSpeech k2 v2',
  baseUrl:
    'https://huggingface.co/reazon-research/reazonspeech-k2-v2/resolve/291488c8151be24d7da4bf7af26e533fad96e407/',
  /** ワーカー内でのファイル名 → 取得元ファイル名 */
  files: {
    'encoder.onnx': 'encoder-epoch-99-avg-1.int8.onnx',
    'decoder.onnx': 'decoder-epoch-99-avg-1.int8.onnx',
    'joiner.onnx': 'joiner-epoch-99-avg-1.int8.onnx',
    'tokens.txt': 'tokens.txt',
  } as Record<string, string>,
  approxMB: 160,
  cacheName: 'gijiroku-asr-v1',
};

export const SAMPLE_RATE = 16000;

export type LlmKey = 'standard' | 'high';
/** 設定画面での選択肢。auto は端末に合わせて自動選択、none はAIを使わない簡易要約。 */
export type LlmChoice = 'auto' | LlmKey | 'none';

/** 要約AIを動かす仕組み。webgpu = GPU（WebLLM、速い）、cpu = CPU（wllama、GPUのない端末でも動く） */
export type LlmEngine = 'webgpu' | 'cpu';

export interface LlmModel {
  key: LlmKey;
  label: string;
  description: string;
  /** GPU（WebLLM）版。f16 は省メモリ計算（shader-f16）対応GPU向け */
  webgpu: { idF16: string; idF32: string; approxGB: number };
  /** CPU（wllama）版の GGUF。null は CPU では重すぎて使わない */
  cpu: { url: string; approxGB: number } | null;
}

const HF = 'https://huggingface.co/';

/**
 * 要約AI。実際の会議の文字起こしで比べて選んだ。
 * - Qwen3.5 2B: Gemma 2 2B 日本語版より決定事項・宿題の取りこぼしが大幅に少なかった
 * - Qwen3.5 0.8B は決定事項・宿題がほぼ使えない出来だったため採用しない（それならAIなしの簡易要約の方が正確）
 */
export const LLM_MODELS: LlmModel[] = [
  {
    key: 'standard',
    label: '標準',
    description: 'Qwen3.5 2B。スマホでも動き、決定事項・宿題を抜き出せます',
    webgpu: { idF16: 'Qwen3.5-2B-q4f16_1-MLC', idF32: 'Qwen3.5-2B-q4f32_1-MLC', approxGB: 1.1 },
    cpu: {
      url: `${HF}unsloth/Qwen3.5-2B-GGUF/resolve/f6d5376be1edb4d416d56da11e5397a961aca8ae/Qwen3.5-2B-Q4_K_M.gguf`,
      approxGB: 1.3,
    },
  },
  {
    key: 'high',
    label: '高精度',
    description: 'Qwen3.5 4B。GPU（WebGPU）のあるPC向け',
    webgpu: { idF16: 'Qwen3.5-4B-q4f16_1-MLC', idF32: 'Qwen3.5-4B-q4f32_1-MLC', approxGB: 2.4 },
    cpu: null,
  },
];

export function llmModel(key: LlmKey): LlmModel {
  return LLM_MODELS.find((m) => m.key === key)!;
}

/** 途中で止まったときに次に使う、ひとつ軽い設定 */
export function lighterChoice(key: LlmKey): LlmKey | 'none' {
  return key === 'high' ? 'standard' : 'none';
}

/**
 * 要約AIが一度に扱う長さ（トークン）。Qwen3.5 は長さが増えても作業用メモリがあまり増えない作りなので、
 * 大きめにして会議全体（約1万字 ≒ 40分程度）を1回で処理できるようにする。
 */
export const LLM_CONTEXT = 8192;
