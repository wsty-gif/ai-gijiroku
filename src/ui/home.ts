import { ASR_MODEL, llmModel } from '../config';
import { isAsrModelCached } from '../asr/modelCache';
import { detectGpu, resolveLlm } from '../device';
import { lastUnfinishedLlmAttempt, listMeetings, loadSettings, markLlmAttempt, newMeetingId, saveSettings } from '../storage';
import { formatDateTime, formatDuration } from '../summarize/text';
import type { Meeting } from '../types';
import { esc, qs } from './dom';
import { navigate } from './router';

export function renderHome(root: HTMLElement): void {
  root.innerHTML = `
    <h1>AI議事録</h1>
    <p class="muted">録音から議事録PDFの作成まで、すべてこのスマホの中で行います。音声や内容が外部に送られることはありません。</p>
    <div id="crash-notice"></div>
    <div class="stack" style="margin-top:16px">
      <button class="primary big" id="start">● 会議を開始</button>
      <button id="import">音声ファイルから作成</button>
      <input type="file" id="file" accept="audio/*,video/mp4,.m4a,.mp3,.wav,.aac,.mp4" hidden />
    </div>
    <div class="card">
      <ul class="status-list" id="status">
        <li><span>文字起こし</span><span class="muted">確認中…</span></li>
      </ul>
    </div>
    <h2>過去の議事録</h2>
    <ul class="meeting-list" id="list"><li class="muted">読み込み中…</li></ul>
    <button class="link" id="settings">設定・このアプリについて</button>
  `;

  let asrCached = false;

  qs(root, '#start').addEventListener('click', () => {
    // モデルが端末にあれば、押した瞬間に録音を始める（iPhoneは操作直後でないと録音を開始できない）
    navigate({ name: 'record', autoStart: asrCached });
  });
  const fileInput = qs<HTMLInputElement>(root, '#file');
  qs(root, '#import').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) navigate({ name: 'process', id: newMeetingId(), file });
  });
  qs(root, '#settings').addEventListener('click', () => navigate({ name: 'settings' }));

  const crashed = lastUnfinishedLlmAttempt();
  if (crashed) {
    const box = qs(root, '#crash-notice');
    box.innerHTML = `
      <div class="notice">
        前回、要約AIの処理中にアプリが終了しました。端末のメモリが足りなかった可能性があります。
        要約AIを「軽量」または「AIを使わない」に切り替えると安定します。
        <div class="row" style="margin-top:8px">
          <button id="to-light">軽量にする</button>
          <button id="dismiss">このまま</button>
        </div>
      </div>`;
    const close = () => {
      markLlmAttempt(null);
      box.innerHTML = '';
    };
    qs(box, '#to-light').addEventListener('click', () => {
      saveSettings({ ...loadSettings(), llm: 'light' });
      close();
      void renderStatus();
    });
    qs(box, '#dismiss').addEventListener('click', close);
  }

  async function renderStatus() {
    const [cached, gpu, llm] = await Promise.all([isAsrModelCached(), detectGpu(), resolveLlm(loadSettings().llm)]);
    asrCached = cached;
    const asr = cached
      ? '<span class="ok">準備済み</span>'
      : `<span class="muted">初回のみ約${ASR_MODEL.approxMB}MBをダウンロード</span>`;
    let summary: string;
    if (llm) {
      const m = llmModel(llm.key);
      summary = `<span>AI（${esc(m.label)}）</span>`;
    } else if (!gpu.webgpu && loadSettings().llm !== 'none') {
      summary = '<span class="muted">簡易要約（この端末はAI非対応）</span>';
    } else {
      summary = '<span class="muted">簡易要約（AIを使わない）</span>';
    }
    qs(root, '#status').innerHTML = `
      <li><span>文字起こし</span>${asr}</li>
      <li><span>要約</span>${summary}</li>`;
  }

  async function renderList() {
    const meetings = await listMeetings();
    const list = qs(root, '#list');
    if (meetings.length === 0) {
      list.innerHTML = '<li class="muted">まだありません</li>';
      return;
    }
    list.innerHTML = meetings.map((m) => item(m)).join('');
    list.querySelectorAll<HTMLButtonElement>('button[data-id]').forEach((b) => {
      b.addEventListener('click', () => {
        const m = meetings.find((x) => x.id === b.dataset.id)!;
        if (m.minutes) navigate({ name: 'edit', id: m.id });
        else navigate({ name: 'process', id: m.id });
      });
    });
  }

  void renderStatus();
  void renderList();
}

function item(m: Meeting): string {
  const title = m.minutes?.title || (m.segments.length ? '議事録 未作成（タップで作成）' : '文字起こしなし');
  return `<li><button data-id="${esc(m.id)}">
      <span class="title">${esc(title)}</span>
      <span class="muted">${esc(formatDateTime(m.createdAt))}・${esc(formatDuration(m.durationSec))}</span>
    </button></li>`;
}
