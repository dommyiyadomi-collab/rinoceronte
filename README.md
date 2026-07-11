# Digital Nomad Japan - Static Starter Site

Cloudflare Pages にアップロードできる静的サイトです。

## 構成

- `public/index.html` トップページ
- `public/visa.html` ビザ情報ページ
- `public/cities.html` 都市情報ページ
- `public/weather.html` 天気情報ページ
- `public/about.html` 事業・サイト説明ページ
- `public/contact.html` 問い合わせページの仮デザイン
- `public/privacy.html` プライバシーポリシー仮ページ
- `public/terms.html` 利用規約仮ページ
- `public/style.css` デザイン
- `public/main.js` 年表示・スマホメニュー
- `wrangler.jsonc` Cloudflare Workers / Pages Assets 用設定
- `public/_headers` Cloudflare Pages 用セキュリティヘッダー
- `public/robots.txt` 検索エンジン用設定
- `public/sitemap.xml` サイトマップ仮ファイル

## Cloudflare Pages での使い方

1. Cloudflare ダッシュボードを開く
2. Workers & Pages → Pages → Create project
3. Direct Upload を選択
4. `public` フォルダ内のファイルをアップロード
5. 独自ドメインを接続

## 公開前に変更する場所

- `Digital Nomad Japan` を正式サイト名に変更
- 独自ドメインを使う場合は `https://rinoceronte.pages.dev/` を自分のドメインに変更
- `privacy.html` と `terms.html` の内容を正式化
- 問い合わせフォームを外部サービスまたは Worker に接続
