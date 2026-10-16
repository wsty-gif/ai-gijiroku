// 外部配布物（文字起こしエンジン・VADモデル・日本語フォント）を public/vendor に取得する。
// 取得元はコミットを固定しているので、何度実行しても同じファイルになる。
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// sherpa-onnx の WebAssembly ビルド（Apache-2.0）。モデル非依存の部分だけを使う。
const SHERPA_SPACE =
  'https://huggingface.co/spaces/k2-fsa/web-assembly-vad-asr-sherpa-onnx-zh-zipformer-ctc/resolve/9d5fc71d88ab1222ed1af2274fb194592af48455';

const files = [
  { url: `${SHERPA_SPACE}/sherpa-onnx-wasm-main-vad-asr.js`, out: 'public/vendor/sherpa/sherpa-onnx-wasm-main-vad-asr.js' },
  { url: `${SHERPA_SPACE}/sherpa-onnx-wasm-main-vad-asr.wasm`, out: 'public/vendor/sherpa/sherpa-onnx-wasm-main-vad-asr.wasm' },
  { url: `${SHERPA_SPACE}/sherpa-onnx-asr.js`, out: 'public/vendor/sherpa/sherpa-onnx-asr.js' },
  { url: `${SHERPA_SPACE}/sherpa-onnx-vad.js`, out: 'public/vendor/sherpa/sherpa-onnx-vad.js' },
  {
    url: 'https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/v1.13.8/LICENSE',
    out: 'public/vendor/sherpa/LICENSE',
  },
  // Silero VAD（MIT）。上記ビルドに同梱されているものと同一（643,854 bytes）。
  {
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
    out: 'public/vendor/sherpa/silero_vad.onnx',
  },
  // BIZ UDPゴシック（SIL Open Font License 1.1）。PDFに埋め込む日本語フォント。
  {
    url: 'https://raw.githubusercontent.com/google/fonts/7da950f21232dc96d330070ae4cd5b98f02026d3/ofl/bizudpgothic/BIZUDPGothic-Regular.ttf',
    out: 'public/vendor/fonts/BIZUDPGothic-Regular.ttf',
  },
  {
    url: 'https://raw.githubusercontent.com/google/fonts/7da950f21232dc96d330070ae4cd5b98f02026d3/ofl/bizudpgothic/OFL.txt',
    out: 'public/vendor/fonts/OFL.txt',
  },
];

async function exists(path) {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

for (const f of files) {
  const out = join(root, f.out);
  if (await exists(out)) {
    console.log(`skip  ${f.out}`);
    continue;
  }
  const data = await download(f.url);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, data);
  console.log(`saved ${f.out} (${(data.length / 1e6).toFixed(1)} MB)`);
}
