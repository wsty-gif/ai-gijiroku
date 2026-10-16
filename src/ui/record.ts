import { ASR_MODEL, SAMPLE_RATE } from '../config';
import { downloadAsrModel, isAsrModelCached } from '../asr/modelCache';
import { TranscriptionSession } from '../asr/session';
import { MicRecorder } from '../audio/recorder';
import { deleteMeeting, newMeetingId, saveMeeting } from '../storage';
import type { Meeting, Segment } from '../types';
import { keepScreenOn } from '../wakeLock';
import { errorMessage, esc, formatBytes, formatClock, qs, toast } from './dom';
import { navigate, setBusy } from './router';

/** 文字起こしモデルが端末に無ければダウンロードする画面部品。完了したら resolve。 */
export function ensureAsrModel(container: HTMLElement): Promise<void> {
  // 失敗してもボタンで再挑戦できるので、成功するまで resolve しない
  return new Promise((resolve) => {
    void isAsrModelCached().then((cached) => {
      if (cached) return resolve();
      container.innerHTML = `
        <div class="card stack">
          <p><b>はじめに文字起こしモデルのダウンロードが必要です</b></p>
          <p class="muted">約${ASR_MODEL.approxMB}MB。初回のみで、以後はオフラインでも使えます。Wi-Fiでのダウンロードをおすすめします。</p>
          <div class="progress" hidden><div></div></div>
          <p class="muted" id="dl-text"></p>
          <button class="primary" id="dl">ダウンロードする</button>
        </div>`;
      const bar = qs(container, '.progress');
      const text = qs(container, '#dl-text');
      const button = qs<HTMLButtonElement>(container, '#dl');
      button.addEventListener('click', async () => {
        button.disabled = true;
        bar.hidden = false;
        void navigator.storage?.persist?.();
        const releaseScreen = keepScreenOn();
        try {
          await downloadAsrModel((loaded, total) => {
            (bar.firstElementChild as HTMLElement).style.width = `${Math.min(100, (loaded / total) * 100)}%`;
            text.textContent = `${formatBytes(loaded)} / 約${formatBytes(total)}`;
          });
          container.innerHTML = '';
          resolve();
        } catch (e) {
          button.disabled = false;
          button.textContent = 'もう一度ダウンロードする';
          text.textContent = `ダウンロードに失敗しました: ${errorMessage(e)}`;
        } finally {
          releaseScreen();
        }
      });
    });
  });
}

export function renderRecord(root: HTMLElement, autoStart: boolean): () => void {
  root.innerHTML = `
    <div class="topbar">
      <button class="link" id="back">← 戻る</button>
    </div>
    <div id="setup"></div>
    <div id="ready" hidden>
      <div class="card stack">
        <p><b>録音の準備ができました</b></p>
        <p class="muted">スマホを話し手の近く（机の中央など）に置いてください。</p>
        <button class="primary big" id="go">● 録音を開始</button>
      </div>
    </div>
    <div id="recording" hidden>
      <div class="rec-header">
        <div><span class="rec-dot" id="dot"></span><span id="state">録音中</span></div>
        <div class="clock" id="clock">00:00:00</div>
      </div>
      <div class="meter"><div id="level"></div></div>
      <div class="transcript" id="transcript"><p class="muted" id="placeholder">話し始めると、ここに文字起こしが表示されます。</p></div>
      <p class="muted" id="backlog"></p>
      <div class="notice">録音中は画面を開いたままにしてください。画面のロックや別のアプリへの切り替えをすると、録音が止まることがあります。</div>
      <div class="stack">
        <button id="pause">一時停止</button>
        <button class="primary big" id="finish">会議を終了して議事録を作成</button>
        <button class="link danger" id="discard">録音を破棄する</button>
      </div>
    </div>
  `;

  const recorder = new MicRecorder();
  let session: TranscriptionSession | undefined;
  let meeting: Meeting | undefined;
  let timer: number | undefined;
  let finished = false;
  let paused = false;

  const show = (id: 'ready' | 'recording') => {
    qs(root, '#ready').hidden = id !== 'ready';
    qs(root, '#recording').hidden = id !== 'recording';
  };

  const stopAll = async () => {
    clearInterval(timer);
    setBusy(false);
    await recorder.stop().catch(() => {});
  };

  qs(root, '#back').addEventListener('click', () => {
    if (meeting && !confirm('録音を破棄して戻りますか？')) return;
    void discard();
  });

  async function discard() {
    finished = true;
    await stopAll();
    session?.dispose();
    if (meeting) await deleteMeeting(meeting.id);
    navigate({ name: 'home' });
  }

  function appendSegment(seg: Segment) {
    const box = qs(root, '#transcript');
    root.querySelector('#placeholder')?.remove();
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    const p = document.createElement('p');
    p.innerHTML = `<span class="time">${esc(formatClock(seg.start))}</span>${esc(seg.text)}`;
    box.appendChild(p);
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  function start() {
    // ここまでは同期で進めること（iPhoneで録音を開始できるようにするため）
    const recording = recorder.start();
    meeting = {
      id: newMeetingId(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      durationSec: 0,
      source: 'mic',
      segments: [],
    };
    session = new TranscriptionSession(meeting);
    session.onSegment = appendSegment;
    session.onError = (m) => toast(`文字起こしでエラー: ${m}`, 6000);
    session.whenReady().catch((e) => {
      toast(`文字起こしを開始できませんでした: ${errorMessage(e)}`, 8000);
    });
    recorder.onAudio = (s) => session!.push(s);
    let levelFrame = 0;
    recorder.onLevel = (level) => {
      cancelAnimationFrame(levelFrame);
      levelFrame = requestAnimationFrame(() => (qs(root, '#level').style.width = `${level * 100}%`));
    };
    recorder.onInterrupted = () => toast('画面が切り替わっていた間、録音が止まっていた可能性があります', 6000);

    setBusy(true);
    show('recording');
    recording
      .then(() => {
        void saveMeeting(meeting!);
        timer = window.setInterval(() => {
          const sec = recorder.recordedSamples / SAMPLE_RATE;
          meeting!.durationSec = sec;
          qs(root, '#clock').textContent = formatClock(sec);
          const backlog = session!.backlogSeconds;
          qs(root, '#backlog').textContent = !session!.isReady
            ? '文字起こしエンジンを準備中です（録音は続いています）'
            : backlog > 5
              ? `文字起こし待ち: 約${Math.round(backlog)}秒分（会議終了後に続きを処理します）`
              : '';
        }, 500);
      })
      .catch(async (e) => {
        await stopAll();
        session?.dispose();
        meeting = undefined;
        show('ready');
        toast(errorMessage(e), 8000);
      });
  }

  qs(root, '#go').addEventListener('click', start);

  qs(root, '#pause').addEventListener('click', () => {
    paused = !paused;
    if (paused) recorder.pause();
    else recorder.resume();
    qs(root, '#pause').textContent = paused ? '再開する' : '一時停止';
    qs(root, '#state').textContent = paused ? '一時停止中' : '録音中';
    qs(root, '#dot').classList.toggle('paused', paused);
  });

  qs(root, '#finish').addEventListener('click', async () => {
    if (!session || !meeting) return;
    if (!confirm('会議を終了して、議事録を作成しますか？')) return;
    finished = true;
    meeting.durationSec = recorder.recordedSamples / SAMPLE_RATE;
    await stopAll();
    navigate({ name: 'process', id: meeting.id, session });
  });

  qs(root, '#discard').addEventListener('click', () => {
    if (confirm('この録音を破棄しますか？（元に戻せません）')) void discard();
  });

  if (autoStart) {
    start();
  } else {
    void ensureAsrModel(qs(root, '#setup')).then(() => show('ready'));
  }

  return () => {
    if (!finished) {
      void stopAll();
      session?.dispose();
    }
  };
}
