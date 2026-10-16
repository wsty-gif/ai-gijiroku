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

export type LlmKey = 'standard' | 'light' | 'high';
/** 設定画面での選択肢。auto は端末に合わせて自動選択、none はAIを使わない簡易要約。 */
export type LlmChoice = 'auto' | LlmKey | 'none';

export interface LlmModel {
  key: LlmKey;
  label: string;
  description: string;
  /** shader-f16 に対応したGPU向け */
  idF16: string;
  /** shader-f16 非対応GPU向け */
  idF32: string;
  approxGB: number;
}

/** 要約AI（WebLLMの事前変換済みモデル）。どれも一度に約4,000トークンまで扱える。 */
export const LLM_MODELS: LlmModel[] = [
  {
    key: 'standard',
    label: '標準',
    description: 'Gemma 2 2B 日本語版。日本語の要約が得意です',
    idF16: 'gemma-2-2b-jpn-it-q4f16_1-MLC',
    idF32: 'gemma-2-2b-jpn-it-q4f32_1-MLC',
    approxGB: 1.5,
  },
  {
    key: 'light',
    label: '軽量',
    description: 'Gemma 3 1B。使うメモリが標準の約半分で、止まりにくい（精度は少し下がります）',
    // Gemma 3 1B は省メモリ計算（shader-f16）対応GPU向けしかないため、非対応GPUでは Qwen3.5 0.8B を使う
    idF16: 'gemma3-1b-it-q4f16_1-MLC',
    idF32: 'Qwen3.5-0.8B-q4f32_1-MLC',
    approxGB: 0.6,
  },
  {
    key: 'high',
    label: '高精度',
    description: 'Gemma 4 E2B。PC向け（スマホのブラウザではメモリ上限を超えて止まることがあります）',
    idF16: 'gemma-4-E2B-it-q4f16_1-MLC',
    idF32: 'gemma-4-E2B-it-q4f32_1-MLC',
    approxGB: 2.8,
  },
];

export function llmModel(key: LlmKey): LlmModel {
  return LLM_MODELS.find((m) => m.key === key)!;
}

/** 途中で止まったときに次に使う、ひとつ軽い設定 */
export function lighterChoice(key: LlmKey): LlmKey | 'none' {
  return key === 'high' ? 'standard' : key === 'standard' ? 'light' : 'none';
}

/**
 * 要約AIが一度に扱う長さ（トークン）。スマホのブラウザは1ページで使えるメモリの上限が
 * 端末のメモリより小さいので、短くして使用量を約300MB減らす（そのぶん細かく分けて処理する）。
 */
export const LLM_CONTEXT_MOBILE = 2048;
export const LLM_CONTEXT_DESKTOP = 4096;
