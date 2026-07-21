# Search Console Sitemaps Collector

## Purpose

The daily audit collects Google Search Console sitemap metadata as read-only
evidence. The collector records the sitemap entries that Search Console returns
for the configured property, including entries exposed through sitemap index
records. It does not generate SEO recommendations, does not run AI analysis,
and does not change production website content.

## Required Authentication

The collector reuses the existing GitHub Actions authentication flow:

1. `.github/workflows/daily-site-audit.yml` requests a GitHub OIDC token.
2. `google-github-actions/auth@v3` exchanges that token through the configured
   Google Cloud Workload Identity Provider.
3. The workflow impersonates the existing daily audit service account and writes
   temporary Application Default Credentials for the job.
4. `scripts/collect-search-console-sitemaps.mjs` uses `google-auth-library` with
   the `https://www.googleapis.com/auth/webmasters.readonly` scope.

No service account key files are required or allowed. The collector reads the
existing `GOOGLE_SEARCH_CONSOLE_SITE_URL` GitHub Secret and does not require any
additional secrets.

## API Endpoint Used

The collector calls the official Search Console Sitemaps API:

```text
GET https://www.googleapis.com/webmasters/v3/sites/{siteUrl}/sitemaps
```

Reference: <https://developers.google.com/webmaster-tools/v1/sitemaps/list>

When Search Console returns a sitemap index record, the collector also calls the
same read-only endpoint with the documented `sitemapIndex` query parameter:

```text
GET https://www.googleapis.com/webmasters/v3/sites/{siteUrl}/sitemaps?sitemapIndex={sitemapUrl}
```

The endpoint version recorded in output is `webmasters/v3`.

## Limitations

- The collector records only values returned by the Search Console Sitemaps API.
- The API exposes warning and error counts, not detailed per-URL issue lists.
- The API exposes processing state as the `isPending` field; no additional
  processing status is inferred.
- URL counts are recorded from `contents[].submitted`, grouped by returned
  content type.
- The deprecated `contents[].indexed` field is intentionally omitted.
- Collection fails if Application Default Credentials are unavailable, the
  Search Console API is disabled, or the service account lacks access to the
  configured Search Console property.

## Output JSON Structure

The collector writes `out/audit-bundle/search-console-sitemaps.json` and merges
the same object into `out/audit-bundle/audit-bundle.json` under the top-level
`searchConsoleSitemaps` key.

```json
{
  "generatedAt": "2026-07-21T00:00:00.000Z",
  "property": "https://example.com/",
  "collectorVersion": "1.0.0",
  "apiVersion": "webmasters/v3",
  "source": {
    "product": "Google Search Console",
    "api": "sitemaps.list",
    "method": "GET",
    "endpoint": "https://www.googleapis.com/webmasters/v3/sites/{siteUrl}/sitemaps",
    "scope": "https://www.googleapis.com/auth/webmasters.readonly",
    "property": "https://example.com/"
  },
  "requests": [
    {
      "sitemapIndex": null,
      "sitemapCount": 1
    }
  ],
  "sitemaps": [
    {
      "path": "https://example.com/sitemap.xml",
      "lastSubmitted": "2026-07-01T00:00:00.000Z",
      "lastDownloaded": "2026-07-02T00:00:00.000Z",
      "isPending": false,
      "isSitemapsIndex": false,
      "type": "sitemap",
      "warnings": 0,
      "errors": 0,
      "contents": [
        {
          "type": "web",
          "submitted": 10
        }
      ],
      "sources": [
        {
          "sitemapIndex": null
        }
      ]
    }
  ],
  "summaryCounts": {
    "totalSitemaps": 1,
    "sitemapIndexes": 0,
    "pending": 0,
    "withWarnings": 0,
    "withErrors": 0,
    "warnings": 0,
    "errors": 0,
    "submittedUrls": 10,
    "bySitemapType": {
      "sitemap": 1
    },
    "byContentType": {
      "web": 1
    }
  },
  "errors": [],
  "warnings": []
}
```
