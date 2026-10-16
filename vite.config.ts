import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig(({ mode }) => ({
  // GitHub Pages のようにサブパスで公開しても動くよう相対パスにする
  base: './',
  plugins: [
    // スマホから同じWi-Fi経由で試すとき（npm run dev:lan）だけ自己署名HTTPSを使う。
    // マイクはHTTPSでないと使えないため。
    mode === 'lan' && basicSsl(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      manifest: {
        name: 'AI議事録',
        short_name: 'AI議事録',
        description: '録音した会議から、スマホの中だけで議事録PDFを作成します',
        lang: 'ja',
        display: 'standalone',
        start_url: './',
        scope: './',
        theme_color: '#1d4ed8',
        background_color: '#ffffff',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // アプリ本体と文字起こしエンジン・フォントを端末に保存し、オフラインでも開けるようにする。
        // AIモデル本体（数百MB〜）はここではなく、各ライブラリがCache Storageに保存する。
        globPatterns: ['**/*.{js,css,html,png,svg,wasm,onnx,ttf}'],
        maximumFileSizeToCacheInBytes: 20 * 1024 * 1024,
        navigateFallback: 'index.html',
      },
    }),
  ],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 7000,
  },
  worker: {
    format: 'es',
  },
}));
