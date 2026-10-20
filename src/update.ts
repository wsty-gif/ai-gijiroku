import { toast } from './ui/dom';
import { whenIdle } from './ui/router';

/**
 * アプリの更新への対応。
 * 新しい版を公開すると、端末側では裏で新しい版に切り替わり、古い版の部品（PDF作成やAIの部品）は消える。
 * 古い画面のまま部品を読み込もうとすると失敗するので、
 *  - 新しい版に切り替わったら、作業中でなければすぐ（作業中なら終わってから）再読み込みする
 *  - 録音や編集を始めた時点で、後で使う部品を先に読み込んでおく
 *  - それでも読み込みに失敗したら、保存を済ませてから再読み込みする
 */

/** 再読み込みの前に済ませる保存処理（編集画面などが登録する） */
const beforeReload = new Set<() => Promise<void>>();

export function onBeforeReload(fn: () => Promise<void>): () => void {
  beforeReload.add(fn);
  return () => beforeReload.delete(fn);
}

let reloading = false;

export function reloadForUpdate(message = 'アプリを更新しました。再読み込みします'): void {
  whenIdle(async () => {
    if (reloading) return;
    reloading = true;
    toast(message);
    await Promise.all([...beforeReload].map((fn) => fn().catch(() => {})));
    setTimeout(() => location.reload(), 600);
  });
}

/** 読み込み失敗が「古い版の部品が消えた」ことによるものか */
export function isStaleModuleError(e: unknown): boolean {
  const text = e instanceof Error ? e.message : String(e);
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported/i.test(text);
}

let warmed = false;

/** 録音・編集の開始時に、後で使う部品（要約AI・PDF作成）を先に読み込んでおく */
export function warmUpModules(): void {
  if (warmed) return;
  warmed = true;
  const load = () => {
    void import('./summarize').catch(() => {});
    void import('./summarize/llm').catch(() => {});
    // 要約AIの部品は、この端末で使う方（GPU版かCPU版）だけ読み込む
    void import('./device')
      .then((d) => d.llmEngine())
      .then(async (engine) => {
        if (engine === 'webgpu') await Promise.all([import('./summarize/webllmBackend'), import('@mlc-ai/web-llm')]);
        if (engine === 'cpu') await Promise.all([import('./summarize/wllamaBackend'), import('@wllama/wllama')]);
      })
      .catch(() => {});
    void import('./pdf').then((m) => m.preloadPdf()).catch(() => {});
  };
  // 画面の描画を邪魔しないよう、少し待ってから
  setTimeout(load, 1500);
}

export function initUpdateHandling(): void {
  if (!('serviceWorker' in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) reloadForUpdate();
    // 初回は、作業していなければ静かに読み直して「クロスオリジン分離」を有効にする（CPUでのAI要約が速くなる）
    else if (!self.crossOriginIsolated) whenIdle(() => location.reload());
  });
  // 部品の読み込み失敗（Vite が知らせる）
  window.addEventListener('vite:preloadError', (e) => {
    e.preventDefault();
    reloadForUpdate();
  });
}
