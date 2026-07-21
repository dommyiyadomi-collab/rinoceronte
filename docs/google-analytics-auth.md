# Google Analytics Data API Authentication

This repository collects basic GA4 metrics for the daily audit bundle through the official Google Analytics Data API client. Do not commit credential files, and do not create `credentials.json` or `token.json` in the repository.

## Required GitHub Secrets

| Secret name | Purpose | Where it will be used |
| --- | --- | --- |
| `GOOGLE_ANALYTICS_CREDENTIALS_JSON` | Stores the Google Cloud service account credential JSON for a service account that has access to the target GA4 property. | Injected by `.github/workflows/daily-site-audit.yml` into `scripts/collect_audit_bundle.sh`, which delegates GA4 collection to `scripts/collect-google-analytics-data.mjs`. |
| `GOOGLE_ANALYTICS_PROPERTY_ID` | Identifies the GA4 property to audit. Use the numeric property ID, such as `123456789`. | Injected by `.github/workflows/daily-site-audit.yml` into `scripts/collect_audit_bundle.sh` and passed to the Google Analytics Data API collector. |

## Setup Notes

- Store the full service account JSON in `GOOGLE_ANALYTICS_CREDENTIALS_JSON`.
- Grant the service account email Viewer access to the target GA4 property before running audit collection.
- Enable the Google Analytics Data API in the Google Cloud project for the service account.
- Store only the numeric GA4 property ID in `GOOGLE_ANALYTICS_PROPERTY_ID`.
- Do not store or commit generated credential files in this repository.
- The daily audit workflow writes `google-analytics-data.json` and the merged `audit-bundle.json` to `out/audit-bundle/`, then uploads that directory as the `audit-bundle` artifact.
