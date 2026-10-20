import type { TranscriptionSession } from '../asr/session';
import { toast } from './dom';

/**
 * 画面遷移。一覧・設定・編集はURL（#/...）で戻れるようにする。
 * 録音中や作成中は「作業中」として、戻る操作で画面が消えないようにする。
 */
export type Route =
  | { name: 'home' }
  | { name: 'settings' }
  | { name: 'edit'; id: string }
  | { name: 'record'; autoStart: boolean }
  | { name: 'process'; id: string; session?: TranscriptionSession; file?: File };

type Renderer = (root: HTMLElement, route: Route) => void | (() => void);

let renderer: Renderer;
let cleanup: void | (() => void);
let busy = false;
let currentHash = '';

function hashOf(route: Route): string {
  switch (route.name) {
    case 'home':
      return '#/';
    case 'settings':
      return '#/settings';
    case 'edit':
      return `#/edit/${route.id}`;
    default:
      return '#/work';
  }
}

function routeOf(hash: string): Route {
  const edit = hash.match(/^#\/edit\/(.+)$/);
  if (edit) return { name: 'edit', id: decodeURIComponent(edit[1]) };
  if (hash === '#/settings') return { name: 'settings' };
  return { name: 'home' };
}

function render(route: Route) {
  if (typeof cleanup === 'function') cleanup();
  const root = document.getElementById('app')!;
  root.innerHTML = '';
  window.scrollTo(0, 0);
  cleanup = renderer(root, route);
}

export function navigate(route: Route, { replace = false } = {}): void {
  currentHash = hashOf(route);
  if (location.hash !== currentHash) {
    if (replace) history.replaceState(null, '', currentHash);
    else history.pushState(null, '', currentHash);
  }
  render(route);
}

let onIdle: (() => void) | null = null;

/** 録音中・作成中は true にする。戻る操作とページ離脱を止める。 */
export function setBusy(value: boolean): void {
  busy = value;
  if (!value && onIdle) {
    const fn = onIdle;
    onIdle = null;
    fn();
  }
}

export function isBusy(): boolean {
  return busy;
}

/** 録音・作成が終わったら（作業中でなければ今すぐ）実行する */
export function whenIdle(fn: () => void): void {
  if (busy) onIdle = fn;
  else fn();
}

export function startRouter(r: Renderer): void {
  renderer = r;
  window.addEventListener('popstate', () => {
    if (busy) {
      history.pushState(null, '', currentHash);
      toast('処理中は戻れません。画面の「終了」ボタンを使ってください');
      return;
    }
    currentHash = location.hash || '#/';
    render(routeOf(currentHash));
  });
  window.addEventListener('beforeunload', (e) => {
    if (busy) e.preventDefault();
  });
  // 作業中の画面（#/work）はリロード後に再現できないので一覧に戻す
  const initial = location.hash === '#/work' ? '#/' : location.hash || '#/';
  currentHash = initial;
  history.replaceState(null, '', initial);
  render(routeOf(initial));
}
