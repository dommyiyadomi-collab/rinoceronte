# Digital Nomad Japan - Static Starter Site

Cloudflare Pages にアップロードできる静的サイトです。

## 構成

- `index.html` トップページ
- `about.html` 事業・サイト説明ページ
- `contact.html` 問い合わせページの仮デザイン
- `privacy.html` プライバシーポリシー仮ページ
- `terms.html` 利用規約仮ページ
- `assets/css/style.css` デザイン
- `assets/js/main.js` 年表示・スマホメニュー
- `_headers` Cloudflare Pages 用セキュリティヘッダー
- `robots.txt` 検索エンジン用設定
- `sitemap.xml` サイトマップ仮ファイル

## Cloudflare Pages での使い方

1. Cloudflare ダッシュボードを開く
2. Workers & Pages → Pages → Create project
3. Direct Upload を選択
4. このフォルダ内のファイルをアップロード
5. 独自ドメインを接続

## 公開前に変更する場所

- `Digital Nomad Japan` を正式サイト名に変更
- `https://example.com/` を自分のドメインに変更
- `privacy.html` と `terms.html` の内容を正式化
- 問い合わせフォームを外部サービスまたは Worker に接続
