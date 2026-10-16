// 文字起こしワーカー（sherpa-onnx の WebAssembly 版を使う）。
// 画面の操作が固まらないよう、音声区間の検出（VAD）と文字起こしをすべてここで行う。
//
// 受信: {type:'init', urls, cacheName} / {type:'audio', samples} / {type:'flush'} / {type:'reset'}
// 送信: {type:'ready'} / {type:'segment', start, end, text} / {type:'processed', samples}
//       {type:'flushed'} / {type:'error', message}
'use strict';

const SAMPLE_RATE = 16000;
const VAD_WINDOW = 512;
const VENDOR = new URL('./vendor/sherpa/', self.location.href).href;

let resolveRuntime;
const runtimeReady = new Promise((resolve) => (resolveRuntime = resolve));

self.Module = {
  locateFile: (path) => VENDOR + path,
  // このビルドには中国語モデルが同梱されているが使わないので、読み込まずに空データを渡す。
  // 日本語モデルは init で後から書き込む。
  getPreloadedPackage: () => new ArrayBuffer(0),
  print: () => {},
  printErr: (text) => console.warn('[sherpa]', text),
  onRuntimeInitialized: () => resolveRuntime(),
};

importScripts(
  VENDOR + 'sherpa-onnx-wasm-main-vad-asr.js',
  VENDOR + 'sherpa-onnx-asr.js',
  VENDOR + 'sherpa-onnx-vad.js',
);

// 音声区間の前後に足す余白。区間の頭や語尾（「〜ます」の「す」など）が切れて
// 認識されないのを防ぐ。合計は minSilenceDuration より短くし、隣の区間と重ならないようにする。
const PAD_BEFORE = Math.round(0.25 * SAMPLE_RATE);
const PAD_AFTER = Math.round(0.3 * SAMPLE_RATE);
// 余白を切り出すために直近の音声を覚えておく（リングバッファ）
const HISTORY = new Float32Array(60 * SAMPLE_RATE);

let vad = null;
let recognizer = null;
let leftover = new Float32Array(0);
let processedSamples = 0;
/** VAD に渡した音声の通算サンプル数（VAD が返す区間の位置と同じ基準） */
let vadSamples = 0;

function remember(samples) {
  let pos = vadSamples % HISTORY.length;
  let offset = 0;
  while (offset < samples.length) {
    const n = Math.min(samples.length - offset, HISTORY.length - pos);
    HISTORY.set(samples.subarray(offset, offset + n), pos);
    offset += n;
    pos = (pos + n) % HISTORY.length;
  }
  vadSamples += samples.length;
}

function recall(from, to) {
  from = Math.max(from, vadSamples - HISTORY.length, 0);
  to = Math.min(to, vadSamples);
  const out = new Float32Array(Math.max(0, to - from));
  for (let i = 0; i < out.length; i++) out[i] = HISTORY[(from + i) % HISTORY.length];
  return out;
}

function feedVad(window) {
  remember(window);
  vad.acceptWaveform(window);
}

async function readModelFile(cache, url) {
  let res = cache ? await cache.match(url) : undefined;
  if (!res) {
    res = await fetch(url);
    if (!res.ok) throw new Error(`モデルを読み込めません (${res.status})`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

async function init(urls, cacheName) {
  await runtimeReady;
  const M = self.Module;
  M.FS_createPath('/', 'm', true, true);

  const cache = 'caches' in self ? await caches.open(cacheName) : null;
  const written = [];
  for (const [name, url] of Object.entries(urls)) {
    M.FS_createDataFile('/m', name, await readModelFile(cache, url), true, false, false);
    written.push(name);
  }
  M.FS_createDataFile('/m', 'vad.onnx', await readModelFile(null, VENDOR + 'silero_vad.onnx'), true, false, false);
  written.push('vad.onnx');

  vad = createVad(M, {
    sileroVad: {
      model: '/m/vad.onnx',
      threshold: 0.5,
      // 読点程度の短い間では区切らない（短すぎる区間は認識が落ちやすい）
      minSilenceDuration: 0.7,
      minSpeechDuration: 0.25,
      maxSpeechDuration: 15,
      windowSize: VAD_WINDOW,
    },
    tenVad: {
      model: '',
      threshold: 0.5,
      minSilenceDuration: 0.5,
      minSpeechDuration: 0.25,
      maxSpeechDuration: 20,
      windowSize: 256,
    },
    sampleRate: SAMPLE_RATE,
    numThreads: 1,
    provider: 'cpu',
    debug: 0,
    bufferSizeInSeconds: 60,
  });
  if (!vad.handle) throw new Error('音声区間検出の初期化に失敗しました');

  recognizer = new OfflineRecognizer(
    {
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: '/m/encoder.onnx', decoder: '/m/decoder.onnx', joiner: '/m/joiner.onnx' },
        tokens: '/m/tokens.txt',
        numThreads: 1,
        provider: 'cpu',
        debug: 0,
        modelType: 'transducer',
      },
      decodingMethod: 'greedy_search',
    },
    M,
  );
  if (!recognizer.handle) throw new Error('文字起こしモデルの初期化に失敗しました');

  // モデルは読み込み済みなので、仮想ファイルを消してメモリを空ける
  for (const name of written) M.FS_unlink('/m/' + name);
}

function decode(samples) {
  const stream = recognizer.createStream();
  stream.acceptWaveform(SAMPLE_RATE, samples);
  recognizer.decode(stream);
  const result = recognizer.getResult(stream);
  stream.free();
  return (result.text || '').trim();
}

function drainSegments() {
  while (!vad.isEmpty()) {
    const seg = vad.front();
    vad.pop();
    const start = seg.start;
    const end = seg.start + seg.samples.length;
    const padded = recall(start - PAD_BEFORE, end + PAD_AFTER);
    const text = decode(padded.length >= seg.samples.length ? padded : seg.samples);
    if (text) {
      self.postMessage({ type: 'segment', start: start / SAMPLE_RATE, end: end / SAMPLE_RATE, text });
    }
  }
}

function acceptAudio(samples) {
  const buf = new Float32Array(leftover.length + samples.length);
  buf.set(leftover);
  buf.set(samples, leftover.length);
  let offset = 0;
  while (buf.length - offset >= VAD_WINDOW) {
    feedVad(buf.subarray(offset, offset + VAD_WINDOW));
    offset += VAD_WINDOW;
    drainSegments();
  }
  leftover = buf.slice(offset);
  processedSamples += samples.length;
  self.postMessage({ type: 'processed', samples: processedSamples });
}

function flush() {
  if (leftover.length > 0) {
    const padded = new Float32Array(VAD_WINDOW);
    padded.set(leftover);
    feedVad(padded);
    leftover = new Float32Array(0);
  }
  // 最後の区間の後ろにも余白を取れるよう、少し無音を足してから締める
  const silence = new Float32Array(VAD_WINDOW);
  for (let n = 0; n < PAD_AFTER; n += VAD_WINDOW) feedVad(silence);
  vad.flush();
  drainSegments();
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'init':
        await init(msg.urls, msg.cacheName);
        self.postMessage({ type: 'ready' });
        break;
      case 'audio':
        acceptAudio(msg.samples);
        break;
      case 'flush':
        flush();
        self.postMessage({ type: 'flushed' });
        break;
      case 'reset':
        vad.reset();
        leftover = new Float32Array(0);
        processedSamples = 0;
        vadSamples = 0;
        break;
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
