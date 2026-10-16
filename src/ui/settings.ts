import { ASR_MODEL, LLM_MODELS, type LlmChoice } from '../config';
import { deleteAsrModel, isAsrModelCached } from '../asr/modelCache';
import { detectGpu } from '../device';
import { listMeetings, loadSettings, saveSettings } from '../storage';
import { errorMessage, esc, formatBytes, qs, toast } from './dom';
import { navigate } from './router';

const CHOICES: { value: LlmChoice; label: string; desc: string }[] = [
  { value: 'auto', label: '自動（おすすめ）', desc: '端末に合わせて「標準」か「軽量」を選びます' },
  ...LLM_MODELS.map((m) => ({ value: m.key, label: m.label, desc: `${m.description}（初回 約${m.approxGB}GB）` })),
  { value: 'none', label: 'AIを使わない', desc: 'キーワードから決定事項・ToDoを抜き出す簡易要約。どの端末でも動きます' },
];

export function renderSettings(root: HTMLElement): void {
  const settings = loadSettings();
  root.innerHTML = `
    <div class="topbar"><button class="link" id="back">← 戻る</button></div>
    <h1>設定</h1>

    <h2>要約AI</h2>
    <div class="card" id="choices">
      ${CHOICES.map(
        (c) => `
        <label class="radio-option">
          <input type="radio" name="llm" value="${c.value}" ${settings.llm === c.value ? 'checked' : ''} />
          <span>${esc(c.label)}<span class="desc">${esc(c.desc)}</span></span>
        </label>`,
      ).join('')}
    </div>
    <p class="muted">AIの処理が途中で止まる・アプリが落ちる場合は「軽量」か「AIを使わない」を選んでください。</p>

    <h2>この端末</h2>
    <div class="card"><ul class="status-list" id="device"><li class="muted">確認中…</li></ul></div>

    <h2>保存データ</h2>
    <div class="card">
      <ul class="status-list" id="storage"><li class="muted">確認中…</li></ul>
      <div class="stack" style="margin-top:12px">
        <button id="del-asr">文字起こしモデルを削除</button>
        <button id="del-llm">要約AIモデルをすべて削除</button>
      </div>
      <p class="muted">削除しても議事録は消えません。次に使うときに再ダウンロードします。</p>
    </div>

    <h2>このアプリについて</h2>
    <div class="card stack">
      <p>録音・文字起こし・要約・PDF作成はすべて端末内で行い、音声や議事録の内容を外部に送信しません。インターネットはAIモデルの初回ダウンロードにだけ使います。</p>
      <p class="muted">使用しているソフトウェア・モデル（敬称略）:<br />
        文字起こし: sherpa-onnx（Apache-2.0）、ReazonSpeech k2 v2（Apache-2.0）、Silero VAD（MIT）<br />
        要約: WebLLM（Apache-2.0）、Gemma 2 日本語版・Gemma 3（Gemma利用規約）、Gemma 4・Qwen3.5（Apache-2.0）<br />
        PDF: pdfmake（MIT）、BIZ UDPゴシック（SIL OFL 1.1）</p>
    </div>
  `;

  qs(root, '#back').addEventListener('click', () => navigate({ name: 'home' }));
  qs(root, '#choices').addEventListener('change', (e) => {
    const value = (e.target as HTMLInputElement).value as LlmChoice;
    saveSettings({ ...loadSettings(), llm: value });
    toast('保存しました');
  });

  qs(root, '#del-asr').addEventListener('click', async () => {
    if (!confirm('文字起こしモデルを削除しますか？')) return;
    await deleteAsrModel();
    toast('削除しました');
    void renderStorage();
  });

  qs(root, '#del-llm').addEventListener('click', async () => {
    if (!confirm('要約AIのモデルをすべて削除しますか？')) return;
    try {
      const webllm = await import('@mlc-ai/web-llm');
      for (const m of LLM_MODELS) {
        for (const id of [m.idF16, m.idF32]) {
          if (await webllm.hasModelInCache(id)) await webllm.deleteModelAllInfoInCache(id);
        }
      }
      toast('削除しました');
    } catch (e) {
      toast(`削除できませんでした: ${errorMessage(e)}`);
    }
    void renderStorage();
  });

  async function renderDevice() {
    const gpu = await detectGpu();
    const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
    qs(root, '#device').innerHTML = `
      <li><span>AI要約（WebGPU）</span><span>${gpu.webgpu ? '<span class="ok">対応</span>' : '非対応'}</span></li>
      <li><span>省メモリ計算（shader-f16）</span><span>${gpu.shaderF16 ? '対応' : '非対応'}</span></li>
      <li><span>メモリ</span><span>${mem ? `${mem}GB以上` : '取得できません'}</span></li>`;
  }

  async function renderStorage() {
    const [asr, meetings, estimate] = await Promise.all([
      isAsrModelCached(),
      listMeetings(),
      navigator.storage?.estimate?.().catch(() => undefined),
    ]);
    qs(root, '#storage').innerHTML = `
      <li><span>文字起こしモデル</span><span>${asr ? `保存済み（約${ASR_MODEL.approxMB}MB）` : 'なし'}</span></li>
      <li><span>議事録</span><span>${meetings.length}件</span></li>
      ${estimate?.usage !== undefined ? `<li><span>使用容量（合計）</span><span>${formatBytes(estimate.usage)}</span></li>` : ''}`;
  }

  void renderDevice();
  void renderStorage();
}
