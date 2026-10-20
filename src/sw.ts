/// <reference lib="webworker" />
// オフライン用の Service Worker。
// アプリ本体を端末に保存してオフラインでも開けるようにするほか、
// 「クロスオリジン分離」用のヘッダーを付けて、CPUでのAI要約が複数のコアを使えるようにする
// （GitHub Pages ではサーバー側でヘッダーを設定できないため、ここで付ける）。
import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, matchPrecache, precache, type PrecacheEntry } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';

declare let self: ServiceWorkerGlobalScope & { __WB_MANIFEST: (PrecacheEntry | string)[] };

self.skipWaiting();
clientsClaim();
precache(self.__WB_MANIFEST);
cleanupOutdatedCaches();

/**
 * 複数コアでの計算（SharedArrayBuffer）に必要なヘッダー。
 * 画面だけでなく、文字起こしのワーカーなどアプリ内のすべてのファイルに付ける
 * （付いていないワーカーは、分離された画面からは読み込めなくなるため）。
 * 外部から読み込むもの（AIモデルなど）はすべて CORS 付きの fetch なので、require-corp でも読み込める。
 */
function withIsolation(res: Response): Response {
  if (res.type === 'opaque' || res.type === 'opaqueredirect') return res;
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// アプリ内のファイルは、端末に保存したもの（なければネットから取ったもの）にヘッダーを付けて返す。
// 画面の読み込み（ナビゲーション）には index.html を返す。
registerRoute(
  ({ url }) => url.origin === self.location.origin,
  async ({ request }) => {
    const cached = await matchPrecache(request.mode === 'navigate' ? 'index.html' : request.url);
    return withIsolation(cached ?? (await fetch(request)));
  },
);
