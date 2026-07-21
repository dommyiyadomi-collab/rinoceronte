# Google Search Console Authentication

This repository is prepared to receive Google Search Console authentication through GitHub Secrets. Do not commit credential files, and do not create `credentials.json` or `token.json` in the repository.

## Required GitHub Secrets

| Secret name | Purpose | Where it will be used |
| --- | --- | --- |
| `GOOGLE_SEARCH_CONSOLE_CREDENTIALS_JSON` | Stores the Google Cloud service account credential JSON for a service account that has access to the target Search Console property. | Injected by `.github/workflows/daily-site-audit.yml` into `scripts/collect_audit_bundle.sh`, which delegates Search Analytics collection to `scripts/collect-search-console-search-analytics.mjs`. |
| `GOOGLE_SEARCH_CONSOLE_SITE_URL` | Identifies the verified Search Console property to audit, either as a URL-prefix property such as `https://example.com/` or a domain property such as `sc-domain:example.com`. | Injected by `.github/workflows/daily-site-audit.yml` into `scripts/collect_audit_bundle.sh` and passed to the Search Analytics API collector. |

## Setup Notes

- Store the full service account JSON in `GOOGLE_SEARCH_CONSOLE_CREDENTIALS_JSON`.
- Grant the service account email access to the target Google Search Console property before running audit collection.
- Store only the property identifier in `GOOGLE_SEARCH_CONSOLE_SITE_URL`.
- Do not store or commit generated credential files in this repository.
- The daily audit workflow writes JSON output to `out/audit-bundle/` and uploads that directory as the `audit-bundle` artifact.
