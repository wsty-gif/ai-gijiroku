import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import type { Meeting, Minutes } from './types';
import { formatDuration } from './summarize/text';

const FONT_FILE = 'BIZUDPGothic-Regular.ttf';
const ACCENT = '#1d4ed8';
const MUTED = '#6b7280';

type PdfMake = typeof import('pdfmake/build/pdfmake');

let pdfMakeReady: Promise<PdfMake> | null = null;

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** pdfmake と日本語フォントを初回だけ読み込む。 */
function loadPdfMake(): Promise<PdfMake> {
  pdfMakeReady ??= (async () => {
    const mod = (await import('pdfmake/build/pdfmake')) as PdfMake & { default?: PdfMake };
    const pdfMake = mod.default ?? mod;
    const res = await fetch(`${import.meta.env.BASE_URL}vendor/fonts/${FONT_FILE}`);
    if (!res.ok) throw new Error('PDF用フォントを読み込めませんでした');
    pdfMake.addVirtualFileSystem({ [FONT_FILE]: toBase64(await res.arrayBuffer()) });
    // 太字用のフォントは容量削減のため持たず、同じ書体を使う（見出しは大きさと色で区別）
    pdfMake.addFonts({
      Japanese: { normal: FONT_FILE, bold: FONT_FILE, italics: FONT_FILE, bolditalics: FONT_FILE },
    });
    return pdfMake;
  })();
  pdfMakeReady.catch(() => (pdfMakeReady = null));
  return pdfMakeReady;
}

/** PDF作成の部品とフォントを先に読み込んでおく（アプリ更新で古い部品が消えても作れるように） */
export async function preloadPdf(): Promise<void> {
  await loadPdfMake();
}

function heading(text: string): Content {
  return {
    stack: [
      { text, style: 'h2' },
      { canvas: [{ type: 'line', x1: 0, y1: 2, x2: 515, y2: 2, lineWidth: 1, lineColor: ACCENT }] },
    ],
    margin: [0, 14, 0, 6],
  };
}

function listOrNone(items: string[], ordered = false): Content {
  if (items.length === 0) return { text: 'なし', color: MUTED };
  return ordered ? { ol: items, style: 'body' } : { ul: items, style: 'body' };
}

function buildDoc(m: Minutes, meeting: Meeting): TDocumentDefinitions {
  const infoRows: [string, string][] = [
    ['日時', m.datetime],
    ['参加者', m.participants || '（未記入）'],
    ['録音時間', formatDuration(meeting.durationSec)],
  ];

  const todoTable: Content =
    m.todos.length === 0
      ? { text: 'なし', color: MUTED }
      : {
          table: {
            headerRows: 1,
            widths: ['*', 80, 80],
            body: [
              [
                { text: '内容', style: 'th' },
                { text: '担当', style: 'th' },
                { text: '期限', style: 'th' },
              ],
              ...m.todos.map((t) => [t.task, t.owner || '—', t.due || '—']),
            ],
          },
          layout: 'lightHorizontalLines',
          style: 'body',
        };

  const content: Content[] = [
    { text: '議事録', color: ACCENT, fontSize: 10, margin: [0, 0, 0, 2] },
    { text: m.title || '会議', style: 'h1' },
    {
      table: {
        widths: [60, '*'],
        body: infoRows.map(([k, v]) => [{ text: k, color: MUTED }, v]),
      },
      layout: 'noBorders',
      style: 'body',
      margin: [0, 6, 0, 0],
    },
    heading('概要'),
    { text: m.summary || '（なし）', style: 'body', lineHeight: 1.5 },
    heading('議題'),
    listOrNone(m.agenda),
    heading('決定事項'),
    listOrNone(m.decisions, true),
    heading('ToDo'),
    todoTable,
    heading('主な議論'),
    listOrNone(m.points),
  ];

  return {
    pageSize: 'A4',
    pageMargins: [40, 48, 40, 56],
    defaultStyle: { font: 'Japanese', fontSize: 10.5, lineHeight: 1.35 },
    info: { title: m.title || '議事録', creator: 'AI議事録' },
    content,
    styles: {
      h1: { fontSize: 18, color: '#111827' },
      h2: { fontSize: 13, color: ACCENT },
      th: { color: MUTED, fontSize: 9.5 },
      body: { fontSize: 10.5 },
    },
    footer: (current: number, count: number) => ({
      columns: [
        {
          text:
            m.method === 'ai'
              ? 'この議事録はAIが自動作成しました。内容をご確認ください。'
              : 'この議事録は自動抽出により作成しました。内容をご確認ください。',
          color: MUTED,
          fontSize: 8,
        },
        { text: `${current} / ${count}`, alignment: 'right', color: MUTED, fontSize: 8 },
      ],
      margin: [40, 20, 40, 0],
    }),
  };
}

export async function createMinutesPdf(meeting: Meeting): Promise<Blob> {
  if (!meeting.minutes) throw new Error('議事録がまだ作成されていません');
  const pdfMake = await loadPdfMake();
  return pdfMake.createPdf(buildDoc(meeting.minutes, meeting)).getBlob();
}

export function pdfFileName(meeting: Meeting): string {
  const d = new Date(meeting.createdAt);
  const p = (n: number) => String(n).padStart(2, '0');
  const title = (meeting.minutes?.title || '会議').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 30);
  return `議事録_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${title}.pdf`;
}

/** 共有シート（LINE・メール・ファイル保存など）で渡す。使えない環境ではダウンロードする。 */
export async function shareOrDownload(blob: Blob, fileName: string): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const file = new File([blob], fileName, { type: 'application/pdf' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: fileName });
      return 'shared';
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled';
    }
  }
  downloadBlob(blob, fileName);
  return 'downloaded';
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
