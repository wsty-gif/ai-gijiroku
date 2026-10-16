/**
 * 画面の自動ロックを止める。録音中だけでなく、文字起こし・要約・モデルのダウンロード中も使う。
 * （ロックされるとブラウザが処理を止めたりページを破棄したりするため）
 * 別アプリから戻ったときは取り直す。返り値の関数で解除する。
 */
export function keepScreenOn(): () => void {
  let sentinel: WakeLockSentinel | null = null;
  let active = true;

  const request = async () => {
    if (!active || sentinel || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    try {
      sentinel = await navigator.wakeLock.request('screen');
      sentinel.addEventListener('release', () => (sentinel = null));
      if (!active) await sentinel.release();
    } catch {
      // 省電力モードなどで拒否されることがある。処理自体は続ける
    }
  };
  const onVisibility = () => void request();

  document.addEventListener('visibilitychange', onVisibility);
  void request();

  return () => {
    active = false;
    document.removeEventListener('visibilitychange', onVisibility);
    void sentinel?.release().catch(() => {});
    sentinel = null;
  };
}
