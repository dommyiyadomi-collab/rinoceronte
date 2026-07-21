# Search Console URL Inspection Collector

## Purpose

The daily audit can collect targeted Google Search Console URL Inspection
evidence for pages that already have explicit Search Analytics decline evidence.
The collector is read-only. It does not generate SEO recommendations, does not
request indexing, does not submit sitemaps, and does not change production
website files.

## Official Endpoint

The collector calls the official URL Inspection API endpoint:

```text
POST https://searchconsole.googleapis.com/v1/urlInspection/index:inspect
```

The output records the API version as `searchconsole/v1`.

This endpoint is not a live URL test. The collector does not run a live
indexability check because this API does not provide one.

## Authentication

The collector reuses the existing daily audit authentication flow:

1. `.github/workflows/daily-site-audit.yml` authenticates to Google Cloud with
   GitHub OIDC and Workload Identity Federation.
2. `google-github-actions/auth@v3` writes temporary Application Default
   Credentials for the job.
3. `scripts/collect-search-console-url-inspection.mjs` uses
   `google-auth-library` with the readonly Search Console scope:
   `https://www.googleapis.com/auth/webmasters.readonly`.

No service account key is required or allowed. The collector does not introduce
new long-lived credentials.

## Configuration

| Name | Required | Purpose |
| --- | --- | --- |
| `GOOGLE_SEARCH_CONSOLE_SITE_URL` | Yes | Existing verified Search Console property, passed by the daily workflow. |
| `GOOGLE_SEARCH_CONSOLE_URL_INSPECTION_MAX_TARGETS` | Yes for requests | Explicit maximum number of URLs to inspect in one run. If missing, the collector writes a skipped result. |
| `GOOGLE_SEARCH_CONSOLE_URL_INSPECTION_LANGUAGE_CODE` | No | Sent as `languageCode` only when explicitly configured. |

The maximum target count must be an integer from `0` through `599`. This guard
keeps the collector below the design report quota of 2,000 queries per site per
day and 600 queries per site per minute. A value of `0` disables requests while
still producing machine-readable output.

## Target Selection

The collector never inspects every sitemap URL. It reads
`out/audit-bundle/audit-bundle.json` and looks only under
`searchConsole.searchAnalytics`.

Targets are selected only when Search Analytics data contains an explicit
page-level `declineEvidence` array. Each entry must contain a page URL using
`inspectionUrl`, `pageUrl`, `url`, `page`, or `dimensions.page`.

The collector does not calculate a decline threshold, compare metric deltas on
its own, or use a score. If explicit decline evidence is absent, it writes a
skipped result with:

```json
{
  "targetSelectionStatus": {
    "status": "skipped",
    "reason": "insufficient_search_analytics_decline_evidence"
  }
}
```

The existing Search Analytics collector currently writes same-period reports
and does not include `searchAnalytics.declineEvidence` or another
current-versus-previous page decline field. Until that prerequisite exists and
the maximum target count is configured, URL Inspection collection will safely
skip.

## URL Validation

Before any API call, the collector:

- requires an absolute `http` or `https` URL
- removes URL fragments before deduplication
- rejects URLs containing credentials
- restricts URL-prefix properties to the configured prefix
- restricts `sc-domain:` properties to the configured domain or subdomains
- deduplicates normalized URLs
- rejects targets beyond the configured maximum

Rejected targets are recorded with machine-readable reasons. The collector never
falls back to sitemap inventory or arbitrary URLs.

## Output Schema

The collector writes:

```text
out/audit-bundle/search-console-url-inspection.json
```

It also merges the same object into:

```text
out/audit-bundle/audit-bundle.json
```

under the top-level key `searchConsoleUrlInspection`.

Top-level fields:

```json
{
  "generatedAt": "2026-07-21T00:00:00.000Z",
  "property": "https://example.com/",
  "collectorVersion": "1.0.0",
  "apiVersion": "searchconsole/v1",
  "endpoint": {
    "method": "POST",
    "url": "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect",
    "scope": "https://www.googleapis.com/auth/webmasters.readonly"
  },
  "selectionSource": {
    "file": "audit-bundle.json",
    "key": "searchConsole.searchAnalytics",
    "requirement": "explicit page-level current-versus-previous decline evidence"
  },
  "targetSelectionStatus": {
    "status": "selected",
    "reason": null,
    "selectedTargetCount": 1,
    "rejectedTargetCount": 0
  },
  "configuredMaximum": {
    "envVar": "GOOGLE_SEARCH_CONSOLE_URL_INSPECTION_MAX_TARGETS",
    "value": 1,
    "status": "configured"
  },
  "selectedTargets": [],
  "rejectedTargets": [],
  "inspectedUrls": [],
  "inspectionResults": [],
  "requestErrors": [],
  "warnings": [],
  "summaryCounts": {}
}
```

Successful responses preserve the returned JSON under
`inspectionResults[].response`. The collector records only fields returned by
the official API, including nested evidence such as `inspectionResult`,
`indexStatusResult`, `coverageState`, `robotsTxtState`, `indexingState`,
`lastCrawlTime`, `pageFetchState`, `googleCanonical`, `userCanonical`,
`crawledAs`, `referringUrls`, `sitemap`, `richResultsResult`, and
`mobileUsabilityResult` when those fields are present.

The summary counts returned states where available, but it does not generate
recommendations, priority scores, ranking predictions, canonical judgments, or
future indexing predictions.

## Failure Isolation

One failed URL Inspection request is recorded in `requestErrors` and does not
discard successful results for other URLs. Authentication failures and invalid
property-level configuration fail the collector clearly.

## Known Prerequisite

The current Search Analytics output does not yet contain explicit
current-versus-previous page decline evidence. A future Search Analytics change
should add page-level `searchAnalytics.declineEvidence[]` entries before this
collector can inspect real targets without guessing.
