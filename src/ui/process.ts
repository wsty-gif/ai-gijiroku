import { SAMPLE_RATE } from '../config';
import { TranscriptionSession } from '../asr/session';
import { decodeAudioFile } from '../audio/fileImport';
import { loadMeeting, loadSettings, saveMeeting } from '../storage';
import { summarize, type SummarizeProgress } from '../summarize';
import { formatDateTime } from '../summarize/text';
import type { Meeting, Segment } from '../types';
import { warmUpModules } from '../update';
import { keepScreenOn } from '../wakeLock';
import { errorMessage, esc, formatClock, qs, toast } from './dom';
import { ensureAsrModel } from './record';
import { navigate, setBusy } from './router';

type StepKey = 'decode' | 'transcribe' | 'summarize';
type StepState = 'pending' | 'active' | 'done';

interface Step {
  key: StepKey;
  label: string;
  state: StepState;
  detail: string;
}

/** ファイル読み込み時、文字起こしエンジンへ一度に渡す音声の長さ */
const FEED_SECONDS = 10;

export function renderProcess(
  root: HTMLElement,
  route: { id: string; session?: TranscriptionSession; file?: File },
): () => void {
  root.innerHTML = `
    <div class="topbar"><button class="link" id="cancel" hidden>← 戻る</button></div>
    <h1>議事録を作成しています</h1>
    <p class="muted">会議が長いほど時間がかかります。</p>
    <div class="notice">完了まで、この画面を開いたままにしてください。画面のロックや別のアプリへの切り替えをすると、処理が止まることがあります（自動ロックは止めています）。</div>
    <div id="setup"></div>
    <div class="card"><ul class="steps" id="steps"></ul></div>
    <button id="quick" hidden>AI要約をやめて、簡易要約ですぐ作成する</button>
    <div class="transcript" id="preview" hidden></div>
    <div id="error"></div>
  `;

  const steps: Step[] = [];
  if (route.file) steps.push({ key: 'decode', label: '音声ファイルの読み込み', state: 'pending', detail: '' });
  if (route.file || route.session) steps.push({ key: 'transcribe', label: '文字起こし', state: 'pending', detail: '' });
  steps.push({ key: 'summarize', label: '要約', state: 'pending', detail: '' });

  const renderSteps = () => {
    qs(root, '#steps').innerHTML = steps
      .map(
        (s) =>
          `<li class="${s.state}">${s.state === 'done' ? '✓ ' : s.state === 'active' ? '… ' : ''}${esc(s.label)}` +
          `${s.detail ? `<span class="detail">${esc(s.detail)}</span>` : ''}</li>`,
      )
      .join('');
  };
  const setStep = (key: StepKey, state: StepState, detail = '') => {
    const s = steps.find((x) => x.key === key);
    if (!s) return;
    s.state = state;
    s.detail = detail;
    renderSteps();
  };
  renderSteps();

  const preview = qs(root, '#preview');
  const appendPreview = (seg: Segment) => {
    preview.hidden = false;
    const p = document.createElement('p');
    p.innerHTML = `<span class="time">${esc(formatClock(seg.start))}</span>${esc(seg.text)}`;
    preview.appendChild(p);
    preview.scrollTop = preview.scrollHeight;
  };

  let disposed = false;
  let activeSession = route.session;
  let timer: number | undefined;
  warmUpModules();
  // 処理中は画面の自動ロックを止める（ロックされるとブラウザが処理を止めたりページを破棄したりする）
  const releaseScreen = keepScreenOn();
  let hiddenAt = 0;
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > 1500) toast('作成中は画面を開いたままにしてください。処理が止まることがあります', 6000);
  };
  document.addEventListener('visibilitychange', onVisibility);

  async function transcribeFile(file: File): Promise<Meeting> {
    setStep('decode', 'active', file.name);
    const pcm = await decodeAudioFile(file);
    const meeting: Meeting = {
      id: route.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      durationSec: pcm.length / SAMPLE_RATE,
      source: 'file',
      fileName: file.name,
      segments: [],
    };
    await saveMeeting(meeting);
    setStep('decode', 'done', file.name);

    setStep('transcribe', 'active', '文字起こしエンジンを準備中…');
    const session = new TranscriptionSession(meeting);
    activeSession = session;
    session.onSegment = appendPreview;
    await session.whenReady();
    const step = FEED_SECONDS * SAMPLE_RATE;
    for (let offset = 0; offset < pcm.length && !disposed; offset += step) {
      session.push(pcm.slice(offset, offset + step));
      await session.waitForBacklogBelow(FEED_SECONDS * 2);
      const doneSec = Math.min(pcm.length, offset + step) / SAMPLE_RATE - session.backlogSeconds;
      const ratio = Math.max(0, doneSec / meeting.durationSec);
      setStep('transcribe', 'active', `${Math.round(ratio * 100)}%（${formatClock(doneSec)} / ${formatClock(meeting.durationSec)}）`);
    }
    return session.finish();
  }

  async function finishRecording(session: TranscriptionSession): Promise<Meeting> {
    setStep('transcribe', 'active', '残りの音声を処理中…');
    preview.hidden = false;
    for (const seg of session.meeting.segments.slice(-5)) appendPreview(seg);
    session.onSegment = appendPreview;
    timer = window.setInterval(() => {
      const left = session.backlogSeconds;
      setStep('transcribe', 'active', left > 1 ? `残り約${Math.round(left)}秒分` : '仕上げ中…');
    }, 500);
    const meeting = await session.finish();
    clearInterval(timer);
    return meeting;
  }

  function showProgress(p: SummarizeProgress) {
    if (p.stage === 'load') {
      const pct = Math.round(p.ratio * 100);
      setStep(
        'summarize',
        'active',
        // 端末に保存済みのときは、読み込みの最後に 100% だけが届くので「準備中」と出す
        p.downloading && pct < 100
          ? `要約AI（${p.modelLabel}）をダウンロード中 ${pct}%（初回のみ。Wi-Fi推奨）`
          : `要約AI（${p.modelLabel}）を準備中…`,
      );
    } else {
      const slow = p.engine === 'cpu' ? '（GPUのない端末のためCPUで処理しています。時間がかかります）' : '';
      const part = p.total > 1 ? ` ${Math.min(p.done + 1, p.total)} / ${p.total}` : '';
      let doing = '・会議の内容を読んでいます';
      if (p.ask?.phase === 'reading') {
        const left = p.ask.remainingSec !== undefined ? `、残り約${formatMinutes(p.ask.remainingSec)}` : '';
        doing = `・会議の内容を読んでいます ${Math.round(p.ask.ratio * 100)}%${left}`;
      } else if (p.ask?.phase === 'writing') {
        doing = `・議事録を書いています（${p.ask.chars}文字）`;
      }
      setStep('summarize', 'active', `要約中（${p.modelLabel}）${part}${doing}${slow}`);
    }
  }

  function formatMinutes(sec: number): string {
    return sec < 60 ? '1分' : `${Math.ceil(sec / 60)}分`;
  }

  // AI要約は端末によって時間がかかるので、途中でやめて簡易要約ですぐ作れるようにする
  const abort = new AbortController();
  const quick = qs<HTMLButtonElement>(root, '#quick');
  quick.addEventListener('click', () => {
    quick.disabled = true;
    quick.textContent = '切り替えています…';
    abort.abort();
  });

  const cancel = qs(root, '#cancel');
  cancel.addEventListener('click', () => navigate({ name: 'home' }));

  async function run() {
    // モデルのダウンロード待ちの間は、戻るボタンで中止できるようにしておく
    if (route.file) {
      cancel.hidden = false;
      await ensureAsrModel(qs(root, '#setup'));
      cancel.hidden = true;
    }
    if (disposed) return;
    setBusy(true);
    qs(root, '#error').innerHTML = '';
    let meeting: Meeting | undefined;
    if (route.file) meeting = await transcribeFile(route.file);
    else if (route.session) meeting = await finishRecording(route.session);
    else meeting = await loadMeeting(route.id);
    if (disposed) return;
    if (!meeting) throw new Error('会議データが見つかりませんでした');
    if (route.file || route.session) setStep('transcribe', 'done', `${meeting.segments.length}件の発言`);

    if (meeting.segments.length === 0) {
      setBusy(false);
      releaseScreen();
      qs(root, '#error').innerHTML = `
        <div class="notice">音声から文字を認識できませんでした。マイクの位置や音量、ファイルの内容を確認してください。</div>
        <button id="home">一覧に戻る</button>`;
      qs(root, '#home').addEventListener('click', () => navigate({ name: 'home' }));
      return;
    }

    setStep('summarize', 'active', '準備中…');
    quick.hidden = loadSettings().llm === 'none';
    // 文字起こしエンジンはここで止めてあるので、要約AIがメモリを使える
    const outcome = await summarize(meeting.id, meeting.segments, loadSettings().llm, showProgress, abort.signal);
    quick.hidden = true;
    const prev = meeting.minutes;
    meeting.minutes = {
      ...outcome.minutes,
      datetime: prev?.datetime ?? formatDateTime(meeting.createdAt),
      participants: prev?.participants ?? '',
      note: outcome.note,
    };
    await saveMeeting(meeting);
    setStep('summarize', 'done', outcome.minutes.method === 'ai' ? 'AIで作成しました' : '簡易要約で作成しました');
    setBusy(false);
    navigate({ name: 'edit', id: meeting.id }, { replace: true });
  }

  function fail(e: unknown) {
    console.error(e);
    clearInterval(timer);
    setBusy(false);
    releaseScreen();
    qs(root, '#error').innerHTML = `
      <div class="notice">作成中にエラーが発生しました: ${esc(errorMessage(e))}</div>
      <div class="stack">
        <button class="primary" id="retry">要約をやり直す</button>
        <button id="home">一覧に戻る</button>
      </div>`;
    qs(root, '#retry').addEventListener('click', () => {
      // 文字起こしは保存済みなので、要約からやり直す
      navigate({ name: 'process', id: route.id }, { replace: true });
    });
    qs(root, '#home').addEventListener('click', () => navigate({ name: 'home' }));
  }

  run().catch(fail);

  return () => {
    disposed = true;
    clearInterval(timer);
    releaseScreen();
    document.removeEventListener('visibilitychange', onVisibility);
    setBusy(false);
    if (activeSession !== route.session) activeSession?.dispose();
  };
}
