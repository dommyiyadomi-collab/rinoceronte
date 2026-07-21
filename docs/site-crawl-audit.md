# Sitemap-Based Site Crawl Audit

The daily site audit includes a read-only site crawl phase that uses
`sitemap.xml` as the primary URL inventory. The collector reads the configured
site base URL from the `SITE_BASE_URL` environment variable and writes two JSON
files into the existing audit bundle output directory:

- `site-url-inventory.json`
- `site-crawl.json`

The collector also merges those structures into `audit-bundle.json` under the
top-level keys `siteInventory` and `siteCrawl`. Existing Search Console and GA4
bundle structures are preserved.

## Crawl Boundaries

- `sitemap.xml` is the primary crawl inventory.
- `robots.txt` is collected as evidence, including declared `Sitemap` lines and
  the rules in any `User-agent: *` group.
- The crawler sends read-only HTTP requests only.
- Page crawls use `GET` requests for URLs found in the sitemap.
- Internal links found on crawled pages are normalized and availability-checked,
  but they do not recursively expand the crawl.
- Internal link availability checks use `HEAD` where supported, with `GET`
  fallback when `HEAD` is rejected or unsupported.
- Redirects are followed only while the next `Location` URL remains inside the
  configured `SITE_BASE_URL` origin. If a redirect would leave that origin, the
  collector records `redirectStop.reason=out_of_origin` and the external
  destination URL without requesting the external destination.
- JavaScript is not executed.
- Forms are not submitted.
- Authentication is not attempted.
- URLs outside the `SITE_BASE_URL` origin are excluded from the sitemap crawl.

This evidence does not prove Google indexability. The robots parser is
conservative and does not emulate a search-engine crawler. URL Inspection is a
separate later phase and is not part of this collector.

## Internal Link Check Matching

Internal link targets are normalized and deduplicated before checks are recorded.
For links that already correspond to a crawled sitemap page, the collector does
not send another network request. It reuses the matching `pageResults` record in
this deterministic order:

1. Exact match on the sitemap page `requestedUrl`.
2. Exact match on the sitemap page `finalUrl`.

The sitemap URL inventory is sorted before crawling, and the first matching
`pageResults` entry wins if multiple sitemap URLs resolve to the same final URL.
Each reused check records `checkSource=pageResults`, `matchType`, and
`matchedPageRequestedUrl`.

## GitHub Actions Configuration

Set this repository variable for the daily audit workflow:

```text
SITE_BASE_URL=https://japan-remote-guide.com
```

`SITE_BASE_URL` is a repository variable, not a secret, because the public site
base URL is not sensitive.
