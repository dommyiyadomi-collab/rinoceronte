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
node scripts/check-render-visibility.mjs
node scripts/check-map.mjs
```

The internal link check verifies local `href` and `src` references in `public/**/*.html`.
The render visibility check prevents scroll-triggered reveal styles from hiding article content in full-page renderers.
The map check verifies that the homepage uses the real Japan map SVG and includes all city pins.

## X Content Operations

The repository includes a source-aware X draft workflow for article updates.

```powershell
node scripts/x-content-ops.mjs
```

The monitor compares the latest GitHub ref with `x/state/article-monitor.json`,
detects new or updated article pages in `public/`, checks recent posts in
`x/history/` and `x/archive/`, records sources in `x/sources/`, writes run logs
to `x/logs/`, and saves only passing post candidates to `x/drafts/`.

For analytics after a post is published, add raw X metrics JSON files under
`x/analytics/raw/`, then run:

```powershell
node scripts/x-analytics-report.mjs
```

The analytics script creates 24-hour, 7-day, and 30-day analysis files in
`x/analytics/` and improvement reports in `x/reports/`. See `x/README.md` for
the expected metric fields and directory map.

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
