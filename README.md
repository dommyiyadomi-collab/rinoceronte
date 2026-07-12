# Japan Remote Guide

`japan-remote-guide.com` の静的サイトです。日本でのリモートワーク、長期滞在、都市選び、天候確認、問い合わせ導線、利用規約、プライバシーポリシーをまとめています。

## Site

- Production: https://japan-remote-guide.com
- Repository: https://github.com/dommyiyadomi-collab/rinoceronte
- Hosting target: Cloudflare Workers / Pages Assets

## Structure

- `public/index.html` home
- `public/visa.html` visa guide
- `public/cities.html` city guide
- `public/weather.html` remote work weather planner
- `public/about.html` operator and site positioning
- `public/contact.html` contact guidance
- `public/feedback.html` requests and reviews
- `public/privacy.html` privacy policy
- `public/terms.html` terms of use
- `public/style.css` shared design
- `public/main.js` shared behavior
- `public/_headers` Cloudflare security headers
- `public/robots.txt` robots policy
- `public/sitemap.xml` sitemap
- `wrangler.jsonc` Cloudflare deployment settings

## Validation

Run the same checks used by GitHub Actions:

```powershell
npx --yes html-validate@latest "public/**/*.html"
node scripts/check-internal-links.mjs
```

The internal link check verifies local `href` and `src` references in `public/**/*.html`.

## Deployment Notes

Cloudflare should serve the `public` directory. The current `wrangler.jsonc` uses:

```json
{
  "name": "rinoceronte",
  "assets": {
    "directory": "./public"
  }
}
```

Do not merge older Cloudflare autoconfiguration changes unless they preserve the `./public` asset directory and the correct project name.

## Repository Management

- Keep `main` as the production branch.
- Use pull requests for risky or multi-file changes.
- Keep GitHub Actions green before publishing changes.
- Prefer GitHub noreply email for future commits if personal email exposure is a concern.
