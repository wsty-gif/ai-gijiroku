# AI議事録（スマホ用Webアプリ）

会議をスマホで録音し、「会議を終了して議事録を作成」を押すと、文字起こし・要約・PDF作成までを**スマホの中だけで**行うWebアプリです。
音声や議事録の内容は外部に送信しません。インターネットは、AIモデルを初回にダウンロードするときだけ使います。

- 費用: 0円（無料のホスティングで公開でき、AIの利用料もかかりません）
- 対応: iPhone・Android（ブラウザで開いて「ホーム画面に追加」で使う）
- Mac・App Store・Google Play は不要

## できること

| 機能 | 内容 |
|---|---|
| 録音しながら文字起こし | 話した内容がほぼリアルタイムで画面に出ます。録音中に処理しておくので、終了後の待ち時間が短くなります |
| 音声ファイルから作成 | iPhoneの「ボイスメモ」などで録った音声（m4a / mp3 / wav）を読み込んで議事録にできます |
| 要約 | 会議名・概要・議題・決定事項・ToDo（担当・期限）・主な議論を作成します |
| 編集 | 作成された内容を画面で直してから PDF にできます（自動保存） |
| PDF | A4・日本語フォント埋め込み。共有シートから LINE・メール・ファイル保存へ渡せます |
| 履歴 | 過去の議事録は端末内に保存され、あとから再編集・再出力できます |

## 仕組み

```
マイク / 音声ファイル
   │ 16kHzに変換
   ▼
[文字起こし]  sherpa-onnx（WebAssembly）＋ ReazonSpeech k2 v2（日本語特化）
   │ 無音で区切った発話ごとに文字起こし（Web Worker内で処理）
   ▼
[要約]  WebGPU が使える端末 → 要約AI（WebLLM）で塊ごとに抽出 → 最後にまとめ
        使えない端末    → キーワードと言い回しから抽出する簡易要約
   ▼
[編集画面] → [PDF]  pdfmake ＋ BIZ UDPゴシック
```

要約AIは端末の性能に合わせて選べます（設定画面）。

| 設定 | モデル | 初回ダウンロード | 向いている端末 |
|---|---|---|---|
| 自動（既定） | 下の「標準」か「軽量」を自動で選択 | — | — |
| 標準 | Gemma 2 2B 日本語版 | 約1.5GB | 多くの端末 |
| 軽量 | Qwen3.5 0.8B | 約0.5GB | メモリの少ない端末 |
| 高精度 | Gemma 4 E2B | 約2.8GB | メモリ8GB以上の高性能な端末 |
| AIを使わない | 簡易要約 | なし | すべての端末 |

## 動作環境と注意点

- **AI要約には WebGPU が必要です。** iPhone は iOS 26 以降の Safari、Android は新しめの Chrome が目安です。非対応の端末では自動的に簡易要約になります。
- **録音中は画面を開いたままにしてください。** Webアプリの制約で、画面ロックや別アプリへの切り替えで録音が止まることがあります（自動ロックは止めています）。長い会議で心配な場合は、ボイスメモで録音して「音声ファイルから作成」を使う方法もあります。
- 文字起こしモデル（約160MB）と要約AIは初回にダウンロードします。Wi-Fi 推奨です。
- AI要約の途中でアプリが落ちた場合（メモリ不足）、次回起動時に「軽量」への切り替えを案内します。

## 開発・動作確認

Node.js 20.19 以上（または 22.12 以上）が必要です。

```bash
npm install
```

```bash
npm run dev
```

ブラウザで http://localhost:5173 を開きます。WebGPU が使える PC の Chrome なら AI要約まで試せます（初回に約1.5GBをダウンロード。使えるかは設定画面の「この端末」で確認できます）。

`public/vendor/` の外部ファイル（文字起こしエンジン・VADモデル・フォント）はリポジトリに含めています。取り直す場合は次を実行します（取得元はコミット固定）。

```bash
npm run fetch-vendor
```

### スマホで試す（PCと同じWi-Fi）

マイクは HTTPS でないと使えないため、自己署名証明書で起動します。

```bash
npm run dev:lan
```

表示された `https://192.168.x.x:5173` をスマホで開き、証明書の警告で「詳細を表示 → このWebサイトを閲覧」（iPhone）などを選びます。Windows のファイアウォール確認が出たら許可してください。

## 無料で公開する

```bash
npm run build
```

できた `dist` フォルダを、次のどちらかで公開します（どちらも無料・HTTPS対応）。

- **Cloudflare Pages（おすすめ）**: ダッシュボードの「Workers & Pages → 作成 → Pages → アセットをアップロード」で `dist` をドラッグ＆ドロップするだけです。
- **GitHub Pages（このリポジトリの設定）**: `main` に push すると、[.github/workflows/deploy.yml](.github/workflows/deploy.yml) が自動でビルドして公開します。初回だけ、GitHub のリポジトリ画面で「Settings → Pages → Source」を「GitHub Actions」にしてください。公開URLは `https://<ユーザー名>.github.io/<リポジトリ名>/` です（サブパスでも動くよう相対パスでビルドしています）。

公開したURLを配れば、各自のスマホで開いて「ホーム画面に追加」するだけで使えます。

## 使用しているソフトウェア・モデル

| 用途 | 名前 | ライセンス |
|---|---|---|
| 文字起こしエンジン | [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)（WebAssembly版） | Apache-2.0 |
| 文字起こしモデル | [ReazonSpeech k2 v2](https://huggingface.co/reazon-research/reazonspeech-k2-v2) | Apache-2.0 |
| 音声区間検出 | Silero VAD | MIT |
| 要約AIの実行 | [WebLLM](https://github.com/mlc-ai/web-llm) | Apache-2.0 |
| 要約モデル | Gemma 2 2B 日本語版 | Gemma 利用規約 |
| 要約モデル | Gemma 4 E2B / Qwen3.5 0.8B | Apache-2.0 |
| PDF | [pdfmake](https://github.com/bpampuch/pdfmake) | MIT |
| フォント | BIZ UDPゴシック | SIL OFL 1.1 |

モデル本体は配布物に含めず、利用者の端末が Hugging Face から直接ダウンロードします。

## ファイル構成

```
public/
  asr-worker.js         文字起こしワーカー（VAD＋認識）
  recorder-worklet.js   マイク音声の取り出し
  vendor/               sherpa-onnx・Silero VAD・フォント
src/
  config.ts             使用モデルの定義（差し替えはここ）
  asr/                  モデルのダウンロード・ワーカーとのやり取り
  audio/                録音・ファイル読み込み・16kHz変換
  summarize/            要約AI（llm.ts）と簡易要約（rules.ts）
  pdf.ts                PDF作成・共有
  ui/                   画面（一覧・録音・作成中・編集・設定）
scripts/
  fetch-vendor.mjs      外部ファイルの取得
  gen-icons.mjs         アイコン生成
```
