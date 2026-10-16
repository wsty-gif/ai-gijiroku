import { ASR_MODEL, lighterChoice, llmModel } from '../config';
import { isAsrModelCached } from '../asr/modelCache';
import { detectGpu, resolveLlm } from '../device';
import {
  finishAiRun,
  listMeetings,
  loadMeeting,
  loadSettings,
  newMeetingId,
  saveSettings,
  unfinishedAiRun,
  type AiRun,
} from '../storage';
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

  const interrupted = unfinishedAiRun();
  if (interrupted) {
    // 案内は一度だけ出す
    finishAiRun();
    void renderInterrupted(interrupted);
  }

  /** 前回のAI要約が途中で止まっていたときの案内。止まった理由に合わせて伝え、続きから作成できるようにする。 */
  async function renderInterrupted(run: AiRun) {
    const meeting = await loadMeeting(run.meetingId);
    const box = qs(root, '#crash-notice');
    let message: string;
    if (run.hidden) {
      message =
        '前回の議事録作成は、画面のロックまたは別のアプリへの切り替えで中断されました（メモリ不足ではありません）。' +
        '作成中は画面を開いたままにしてください。';
    } else {
      const next = lighterChoice(run.key);
      saveSettings({ ...loadSettings(), llm: next });
      const nextLabel = next === 'none' ? 'AIを使わない簡易要約' : `「${llmModel(next).label}」`;
      message =
        `前回の議事録作成中に、ブラウザが処理を止めました。スマホのブラウザは、1つのページで使えるメモリに端末のメモリより小さい上限があり、` +
        `要約AI「${llmModel(run.key).label}」がその上限を超えた可能性があります。次からは${nextLabel}で作成します（設定で変更できます）。`;
    }
    const canResume = !!meeting && meeting.segments.length > 0;
    box.innerHTML = `
      <div class="notice">
        ${esc(message)}${canResume ? ' 文字起こしは保存されています。' : ''}
        <div class="row" style="margin-top:8px">
          ${canResume ? '<button class="primary" id="resume">続きから作成</button>' : ''}
          <button id="dismiss">閉じる</button>
        </div>
      </div>`;
    box.querySelector('#resume')?.addEventListener('click', () => navigate({ name: 'process', id: run.meetingId }));
    qs(box, '#dismiss').addEventListener('click', () => (box.innerHTML = ''));
    void renderStatus();
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
