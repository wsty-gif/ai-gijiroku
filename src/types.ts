/** 文字起こしの1区間（発話のまとまり）。時刻は録音開始からの秒数。 */
export interface Segment {
  start: number;
  end: number;
  text: string;
}

export interface Todo {
  task: string;
  owner: string;
  due: string;
}

export interface Minutes {
  title: string;
  datetime: string;
  participants: string;
  summary: string;
  agenda: string[];
  decisions: string[];
  todos: Todo[];
  points: string[];
  /** ai: 要約AIで作成 / rule: キーワード抽出による簡易要約 */
  method: 'ai' | 'rule';
  model?: string;
  /** AI要約を使えなかった理由など、編集画面で利用者に伝えること */
  note?: string;
}

export interface Meeting {
  id: string;
  createdAt: number;
  updatedAt: number;
  /** 録音（または読み込んだ音声）の長さ（秒） */
  durationSec: number;
  source: 'mic' | 'file';
  fileName?: string;
  segments: Segment[];
  minutes?: Minutes;
}
