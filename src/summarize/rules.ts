import type { Segment, Todo } from '../types';
import { dedupe, dedupeTodos } from './text';

/**
 * AIを使わない簡易要約。キーワードと言い回しから決定事項・ToDo・要点を拾う。
 * WebGPUが使えない端末や、AI要約に失敗したときの代わりに使う。
 */

const DECISION =
  /(決定|決まり|決まっ|決めまし|決めましょう|合意|承認|採用|確定|ことにしま|ことになりま|で進めま|で進めましょう|でいきま|で行きま|でいこう|方針|目標にしま)/;
const TODO =
  /(お願いします|お願いでき|お願いしたい|までに|やっておきます|やります|対応しま|対応お願い|確認しま|確認しておきます|確認お願い|担当|宿題|期限|準備しま|送りま|送っておきます|共有しま|共有しておきます|連絡しま|連絡して|調整しま|作成しま|作っておきます|調べておきます|検討しま)/;
const DUE =
  /(\d{1,2}月\d{1,2}日|[一二三四五六七八九十]{1,3}月[一二三四五六七八九十]{1,3}日|\d{1,2}\/\d{1,2}|\d{1,2}日(?:まで|中)|来週の?[月火水木金土日]曜日?|来週|再来週|今週中?|明日|明後日|あさって|今日中|今月末|月末|週明け|来月|[月火水木金土日]曜日)/;
const OWNER = /([一-龥々ァ-ヶーA-Za-z]{1,8})さん/;
/** 「さん」が付いても担当者ではない言葉 */
const NOT_OWNER = new Set(['皆', 'みな', 'お客', '皆様', '先方', '相手']);

const STOP_WORDS = new Set([
  '今日', '時間', '感じ', '部分', '場合', '自分', '皆さん', 'みなさん', '大丈夫', '本当', '一応', '結構',
  '全然', '実際', '意味', '必要', '大体', '最初', '最後', '今回', '前回', '次回', '以上', '以下', '方向',
  '形', '辺り', 'あたり', '関係', '状況', '状態', '内容', '話', 'お話', '質問', '何か', 'ところ', 'ちょっと',
  'そうですね', 'ありがとう', 'よろしく', 'お願い', 'ミーティング', '会議',
]);

function sentencesOf(segments: Segment[]): string[] {
  const out: string[] = [];
  for (const seg of segments) {
    // 古いSafariは後読み正規表現に未対応なので、区切り文字の後ろに改行を入れて分ける
    for (const s of seg.text.replace(/([。！？!?])/g, '$1\n').split('\n')) {
      const t = s.trim();
      if (t.length >= 4) out.push(t);
    }
  }
  return out;
}

const COMPOUND_PART = /^[一-龥々〆ヵヶァ-ヶーA-Za-z0-9]+$/;

/**
 * 文を単語に分ける。漢字・カタカナが続く部分は「新商品発表会」のように1語にまとめる
 * （ブラウザの単語分割は「発表」「会」のように細かく切るため）。
 */
function words(text: string): string[] {
  const Segmenter = (Intl as typeof Intl & { Segmenter?: new (l: string, o: object) => { segment(t: string): Iterable<{ segment: string; isWordLike?: boolean }> } }).Segmenter;
  if (!Segmenter) return text.match(/[一-龥々]+|[ァ-ヶー]+|[A-Za-z][A-Za-z0-9]+/g) ?? [];
  const out: string[] = [];
  let run = '';
  for (const s of new Segmenter('ja', { granularity: 'word' }).segment(text)) {
    if (s.isWordLike && COMPOUND_PART.test(s.segment) && (run + s.segment).length <= 10) {
      run += s.segment;
      continue;
    }
    if (run) out.push(run);
    run = s.isWordLike && COMPOUND_PART.test(s.segment) ? s.segment : '';
    if (s.isWordLike && !run) out.push(s.segment);
  }
  if (run) out.push(run);
  return out;
}

/** 日付・曜日などは話題ではないので除く */
const TIME_WORD = /^(来週|今週|再来週|先週|明日|明後日|昨日|今日|今月|来月|先月|今月末|月末|週明け|午前|午後|[月火水木金土日]曜日?|\d+[月日時分])$/;

function isKeyword(w: string): boolean {
  if (STOP_WORDS.has(w) || TIME_WORD.test(w)) return false;
  return /^[一-龥々〆ヵヶ]{2,}$/.test(w) || /^[ァ-ヶー]{3,}$/.test(w) || /^[A-Za-z][A-Za-z0-9]{2,}$/.test(w);
}

function topKeywords(sentences: string[], limit: number): { word: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const s of sentences) {
    for (const w of words(s)) {
      if (isKeyword(w)) counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word, count]) => ({ word, count }));
}

function toTodo(sentence: string): Todo {
  const owner = sentence.match(OWNER)?.[1] ?? '';
  return {
    task: sentence,
    owner: NOT_OWNER.has(owner) ? '' : owner,
    due: sentence.match(DUE)?.[1] ?? '',
  };
}

export interface RuleResult {
  title: string;
  summary: string;
  agenda: string[];
  decisions: string[];
  todos: Todo[];
  points: string[];
}

export function summarizeByRules(segments: Segment[]): RuleResult {
  const sentences = sentencesOf(segments);
  const keywords = topKeywords(sentences, 8);
  const weight = new Map(keywords.map((k) => [k.word, k.count]));

  const decisions = dedupe(sentences.filter((s) => DECISION.test(s)));
  const todos = dedupeTodos(sentences.filter((s) => TODO.test(s) && !DECISION.test(s)).map(toTodo));

  const pointCount = Math.min(8, Math.max(3, Math.round(sentences.length / 15)));
  const points = sentences
    .map((s, i) => {
      const score = words(s).reduce((sum, w) => sum + (weight.get(w) ?? 0), 0);
      const lengthOk = s.length >= 12 && s.length <= 120;
      return { s, i, score: lengthOk ? score : score / 4 };
    })
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, pointCount)
    .sort((a, b) => a.i - b.i)
    .map((p) => p.s);

  const agenda = keywords.slice(0, 5).map((k) => k.word);
  const title = agenda.length > 0 ? `${agenda.slice(0, 2).join('・')}に関する会議` : '会議';
  const parts: string[] = [];
  if (agenda.length > 0) parts.push(`主な話題は${agenda.map((a) => `「${a}」`).join('')}でした。`);
  parts.push(`決定事項は${decisions.length}件、ToDoは${todos.length}件を抽出しました。`);
  parts.push('（AIを使わない簡易要約のため、内容を確認・修正してください）');

  return { title, summary: parts.join(''), agenda, decisions, todos, points: dedupe(points) };
}
