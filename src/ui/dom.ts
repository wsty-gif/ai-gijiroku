/** HTMLに埋め込む文字列をエスケープする。 */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function qs<T extends HTMLElement = HTMLElement>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`element not found: ${selector}`);
  return el;
}

let toastTimer: number | undefined;

export function toast(message: string, ms = 3000): void {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove('show'), ms);
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)}GB`;
  return `${Math.round(bytes / 1e6)}MB`;
}

export function formatClock(sec: number): string {
  const s = Math.floor(sec);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

export function errorMessage(e: unknown): string {
  if (e instanceof DOMException && e.name === 'NotAllowedError') {
    return 'マイクの使用が許可されていません。ブラウザの設定でマイクを許可してください。';
  }
  if (e instanceof DOMException && e.name === 'NotFoundError') return 'マイクが見つかりません。';
  return e instanceof Error ? e.message : String(e);
}
