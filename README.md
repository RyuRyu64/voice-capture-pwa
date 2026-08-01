# キャプチャ — Voice Capture PWA

喋るだけでアイデア・TODOを構造化して、GitHubのナレッジリポジトリに自動コミットするPWA。

```
録音 → Groq Whisperで文字起こし → Groq LLMで分類（何を/どこで/いつ/緊急度）
→ プレビューで確認 → GitHub Contents APIでリポジトリにコミット
```

- ビルドなしの vanilla HTML/CSS/JS。GitHub Pagesでそのまま動く
- **APIキー（Groq / GitHub PAT）はコードに含まれない。** 初回に設定画面から入力し、端末の localStorage にのみ保存される
- 保存先ルール: アイデア → `ideas/YYYY-MM-DD_slug.md` を新規作成 / TODO・メモ → `INBOX.md` に追記

## 使い方

1. ページを開き、ホーム画面に追加（iOS: 共有 → ホーム画面に追加 / Android: インストール）
2. 設定で Groq APIキー・GitHub Fine-grained PAT（対象リポジトリの Contents: Read and write のみ）・リポジトリ名を入力
3. ＋ボタン → 喋る → 確認 → 保存

## 開発

```sh
python3 -m http.server 8080  # ローカル確認
node tools/make-icons.js     # アイコン再生成
```
