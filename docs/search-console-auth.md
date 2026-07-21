# Google Search Console Authentication

The daily site audit authenticates to Google Cloud from GitHub Actions using GitHub OIDC, Google Cloud Workload Identity Federation, and Application Default Credentials. Do not commit credential files, and do not create `credentials.json`, `token.json`, or generated `gha-creds-*.json` files in the repository.

## Authentication Flow

1. GitHub Actions requests an OIDC token for the authorized repository `dommyiyadomi-collab/rinoceronte`.
2. `google-github-actions/auth@v3` exchanges that token through the Workload Identity Provider `projects/220417285922/locations/global/workloadIdentityPools/github-pool/providers/github`.
3. The workflow impersonates `github-daily-site-audit@project-f1eb455e-61ca-400a-be3.iam.gserviceaccount.com` in Google Cloud project `project-f1eb455e-61ca-400a-be3`.
4. The action writes a temporary ADC credentials file for the job. `scripts/collect-search-console-search-analytics.mjs` uses `google-auth-library` to request the Search Console readonly scope.

## Required GitHub Secrets

| Secret name | Purpose | Where it will be used |
| --- | --- | --- |
| `GOOGLE_SEARCH_CONSOLE_SITE_URL` | Identifies the verified Search Console property to audit, either as a URL-prefix property such as `https://example.com/` or a domain property such as `sc-domain:example.com`. | Injected by `.github/workflows/daily-site-audit.yml` into `scripts/collect_audit_bundle.sh` and passed to the Search Analytics API collector. |

## Setup Notes

- Grant the service account email access to the target Google Search Console property before running audit collection.
- Enable the Google Search Console API in the Google Cloud project.
- Enable the Google Cloud APIs required for Workload Identity Federation and service account impersonation, including the IAM Service Account Credentials API.
- Store only the property identifier in `GOOGLE_SEARCH_CONSOLE_SITE_URL`.
- Do not create or store service-account private key JSON for this workflow.
- Do not store or commit generated credential files in this repository.
- The daily audit workflow writes JSON output to `out/audit-bundle/` and uploads that directory as the `audit-bundle` artifact.
