import { ASR_MODEL } from '../config';

/** ワーカー内ファイル名 → ダウンロードURL */
export function asrModelUrls(): Record<string, string> {
  const urls: Record<string, string> = {};
  for (const [name, remote] of Object.entries(ASR_MODEL.files)) {
    urls[name] = ASR_MODEL.baseUrl + remote;
  }
  return urls;
}

export async function isAsrModelCached(): Promise<boolean> {
  if (!('caches' in self)) return false;
  const cache = await caches.open(ASR_MODEL.cacheName);
  for (const url of Object.values(asrModelUrls())) {
    if (!(await cache.match(url))) return false;
  }
  return true;
}

export type DownloadProgress = (loadedBytes: number, totalBytes: number) => void;

/** 文字起こしモデルを端末（Cache Storage）に保存する。保存済みのファイルは飛ばす。 */
export async function downloadAsrModel(onProgress: DownloadProgress): Promise<void> {
  const cache = await caches.open(ASR_MODEL.cacheName);
  const urls = Object.values(asrModelUrls());
  const approxTotal = ASR_MODEL.approxMB * 1e6;
  let done = 0;
  for (const url of urls) {
    const cached = await cache.match(url);
    if (cached) {
      done += Number(cached.headers.get('content-length') ?? 0);
      onProgress(done, approxTotal);
      continue;
    }
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`モデルの取得に失敗しました (${res.status})`);
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      chunks.push(value);
      size += value.length;
      onProgress(done + size, approxTotal);
    }
    const blob = new Blob(chunks as BlobPart[]);
    chunks.length = 0;
    await cache.put(
      url,
      new Response(blob, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(size) } }),
    );
    done += size;
  }
  onProgress(approxTotal, approxTotal);
}

export async function deleteAsrModel(): Promise<void> {
  if ('caches' in self) await caches.delete(ASR_MODEL.cacheName);
}
