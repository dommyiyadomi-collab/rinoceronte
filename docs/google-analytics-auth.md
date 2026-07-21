# Google Analytics Data API Authentication

The daily site audit collects basic GA4 metrics through the official Google Analytics Data API client. GitHub Actions authenticates to Google Cloud using GitHub OIDC, Google Cloud Workload Identity Federation, and Application Default Credentials. Do not commit credential files, and do not create `credentials.json`, `token.json`, or generated `gha-creds-*.json` files in the repository.

## Authentication Flow

1. GitHub Actions requests an OIDC token for the authorized repository `dommyiyadomi-collab/rinoceronte`.
2. `google-github-actions/auth@v3` exchanges that token through the Workload Identity Provider `projects/220417285922/locations/global/workloadIdentityPools/github-pool/providers/github`.
3. The workflow impersonates `github-daily-site-audit@project-f1eb455e-61ca-400a-be3.iam.gserviceaccount.com` in Google Cloud project `project-f1eb455e-61ca-400a-be3`.
4. The action writes a temporary ADC credentials file for the job. `scripts/collect-google-analytics-data.mjs` lets `@google-analytics/data` discover those credentials automatically.

## Required GitHub Secrets

| Secret name | Purpose | Where it will be used |
| --- | --- | --- |
| `GOOGLE_ANALYTICS_PROPERTY_ID` | Identifies the GA4 property to audit. Use the numeric property ID, such as `123456789`. | Injected by `.github/workflows/daily-site-audit.yml` into `scripts/collect_audit_bundle.sh` and passed to the Google Analytics Data API collector. |

## Setup Notes

- Grant the service account email Viewer access to the target GA4 property before running audit collection.
- Enable the Google Analytics Data API in the Google Cloud project.
- Enable the Google Cloud APIs required for Workload Identity Federation and service account impersonation, including the IAM Service Account Credentials API.
- Store only the numeric GA4 property ID in `GOOGLE_ANALYTICS_PROPERTY_ID`.
- Do not create or store service-account private key JSON for this workflow.
- Do not store or commit generated credential files in this repository.
- The daily audit workflow writes `google-analytics-data.json` and the merged `audit-bundle.json` to `out/audit-bundle/`, then uploads that directory as the `audit-bundle` artifact.
