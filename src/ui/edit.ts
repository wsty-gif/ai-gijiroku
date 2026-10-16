import { createMinutesPdf, downloadBlob, pdfFileName, shareOrDownload } from '../pdf';
import { deleteMeeting, loadMeeting, saveMeeting } from '../storage';
import type { Meeting, Minutes, Todo } from '../types';
import { errorMessage, esc, formatClock, qs, toast } from './dom';
import { navigate } from './router';

const lines = (items: string[]) => items.join('\n');
const toItems = (text: string) =>
  text
    .split('\n')
    // 行頭の「・」「-」「1.」などの記号だけを外す（「3月10日」のような数字は残す）
    .map((s) => s.replace(/^\s*(?:[-・•*]|\d+[.)．）])\s*/, '').trim())
    .filter(Boolean);

export function renderEdit(root: HTMLElement, id: string): () => void {
  root.innerHTML = '<p class="muted">読み込み中…</p>';
  let saveTimer: number | undefined;
  let meeting: Meeting | undefined;

  const persist = () => {
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => meeting && void saveMeeting(meeting), 600);
  };

  void loadMeeting(id).then((m) => {
    if (!m) {
      root.innerHTML = '<p>議事録が見つかりませんでした。</p><button id="home">一覧に戻る</button>';
      qs(root, '#home').addEventListener('click', () => navigate({ name: 'home' }));
      return;
    }
    if (!m.minutes) {
      navigate({ name: 'process', id: m.id }, { replace: true });
      return;
    }
    meeting = m;
    render(m, m.minutes);
  });

  function render(m: Meeting, minutes: Minutes) {
    root.innerHTML = `
      <div class="topbar">
        <button class="link" id="back">← 一覧</button>
        <span class="muted">${minutes.method === 'ai' ? 'AIで作成' : '簡易要約'}・自動保存</span>
      </div>
      ${minutes.note ? `<div class="notice">${esc(minutes.note)}</div>` : ''}
      <p class="muted">内容を確認・修正してから、PDFを作成してください。</p>

      <label for="f-title">会議名</label>
      <input type="text" id="f-title" value="${esc(minutes.title)}" />
      <div class="row">
        <div>
          <label for="f-datetime">日時</label>
          <input type="text" id="f-datetime" value="${esc(minutes.datetime)}" />
        </div>
        <div>
          <label for="f-participants">参加者</label>
          <input type="text" id="f-participants" value="${esc(minutes.participants)}" placeholder="例: 田中、佐藤" />
        </div>
      </div>

      <label for="f-summary">概要</label>
      <textarea id="f-summary" rows="5">${esc(minutes.summary)}</textarea>

      <label for="f-agenda">議題 <span class="hint">1行に1つ</span></label>
      <textarea id="f-agenda">${esc(lines(minutes.agenda))}</textarea>

      <label for="f-decisions">決定事項 <span class="hint">1行に1つ</span></label>
      <textarea id="f-decisions">${esc(lines(minutes.decisions))}</textarea>

      <label>ToDo</label>
      <div id="todos"></div>
      <button id="add-todo">＋ ToDoを追加</button>

      <label for="f-points">主な議論 <span class="hint">1行に1つ</span></label>
      <textarea id="f-points" rows="6">${esc(lines(minutes.points))}</textarea>

      <div class="stack" style="margin-top:20px">
        <button class="primary big" id="share">PDFを作成して共有</button>
        <button id="download">PDFをダウンロード</button>
      </div>

      <details>
        <summary>文字起こし全文を見る（PDFには含まれません）</summary>
        <div class="transcript" style="height:auto;max-height:60vh;margin-top:8px">
          ${m.segments.map((s) => `<p><span class="time">${esc(formatClock(s.start))}</span>${esc(s.text)}</p>`).join('')}
        </div>
      </details>

      <div class="stack">
        <button id="regenerate">要約を作り直す</button>
        <button class="link danger" id="delete">この議事録を削除</button>
      </div>
    `;

    const bindText = (selector: string, apply: (value: string) => void) => {
      qs<HTMLInputElement | HTMLTextAreaElement>(root, selector).addEventListener('input', (e) => {
        apply((e.target as HTMLInputElement).value);
        persist();
      });
    };
    bindText('#f-title', (v) => (minutes.title = v));
    bindText('#f-datetime', (v) => (minutes.datetime = v));
    bindText('#f-participants', (v) => (minutes.participants = v));
    bindText('#f-summary', (v) => (minutes.summary = v));
    bindText('#f-agenda', (v) => (minutes.agenda = toItems(v)));
    bindText('#f-decisions', (v) => (minutes.decisions = toItems(v)));
    bindText('#f-points', (v) => (minutes.points = toItems(v)));

    const renderTodos = () => {
      const box = qs(root, '#todos');
      box.innerHTML = minutes.todos.length
        ? minutes.todos
            .map(
              (t, i) => `
          <div class="todo-item" data-i="${i}">
            <textarea data-k="task" placeholder="やること">${esc(t.task)}</textarea>
            <div class="row">
              <input type="text" data-k="owner" placeholder="担当" value="${esc(t.owner)}" />
              <input type="text" data-k="due" placeholder="期限" value="${esc(t.due)}" />
            </div>
            <button class="danger" data-remove="${i}">削除</button>
          </div>`,
            )
            .join('')
        : '<p class="muted">ToDoはありません</p>';
      box.querySelectorAll<HTMLElement>('.todo-item').forEach((item) => {
        const todo = minutes.todos[Number(item.dataset.i)];
        item.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-k]').forEach((input) => {
          input.addEventListener('input', () => {
            todo[input.dataset.k as keyof Todo] = input.value;
            persist();
          });
        });
      });
      box.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach((b) =>
        b.addEventListener('click', () => {
          minutes.todos.splice(Number(b.dataset.remove), 1);
          persist();
          renderTodos();
        }),
      );
    };
    renderTodos();

    qs(root, '#add-todo').addEventListener('click', () => {
      minutes.todos.push({ task: '', owner: '', due: '' });
      persist();
      renderTodos();
      root.querySelector<HTMLTextAreaElement>('.todo-item:last-child textarea')?.focus();
    });

    const makePdf = async (button: HTMLButtonElement, deliver: (blob: Blob, name: string) => Promise<unknown> | void) => {
      const label = button.textContent;
      button.disabled = true;
      button.textContent = 'PDFを作成中…';
      try {
        minutes.todos = minutes.todos.filter((t) => t.task.trim());
        clearTimeout(saveTimer);
        await saveMeeting(m);
        const blob = await createMinutesPdf(m);
        await deliver(blob, pdfFileName(m));
      } catch (e) {
        toast(`PDFを作成できませんでした: ${errorMessage(e)}`, 6000);
      } finally {
        button.disabled = false;
        button.textContent = label;
      }
    };
    const shareBtn = qs<HTMLButtonElement>(root, '#share');
    shareBtn.addEventListener('click', () => makePdf(shareBtn, shareOrDownload));
    const dlBtn = qs<HTMLButtonElement>(root, '#download');
    dlBtn.addEventListener('click', () => makePdf(dlBtn, downloadBlob));

    qs(root, '#back').addEventListener('click', () => navigate({ name: 'home' }));
    qs(root, '#regenerate').addEventListener('click', () => {
      if (!confirm('要約を作り直しますか？（いま編集した内容は上書きされます。日時・参加者はそのままです）')) return;
      clearTimeout(saveTimer);
      void saveMeeting(m).then(() => navigate({ name: 'process', id: m.id }));
    });
    qs(root, '#delete').addEventListener('click', async () => {
      if (!confirm('この議事録を削除しますか？（元に戻せません）')) return;
      clearTimeout(saveTimer);
      await deleteMeeting(m.id);
      navigate({ name: 'home' });
    });
  }

  return () => {
    // 画面を離れるときは保存待ちを即時に保存する
    if (saveTimer !== undefined && meeting) {
      clearTimeout(saveTimer);
      void saveMeeting(meeting);
    }
  };
}
