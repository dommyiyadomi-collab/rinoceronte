# GitHub Repository and CI Metadata Collector

## Purpose

The daily audit collects GitHub repository and CI metadata as read-only
evidence before any proposal stage. This collector adds the GitHub repository
and CI metadata layer described by the project design report alongside Search
Console API, Google Analytics Data API, and site crawl evidence.

The collector does not generate recommendations, risk scores, priority scores,
implementation instructions, or AI proposals.

## Authentication

The daily audit workflow uses the existing GitHub Actions `GITHUB_TOKEN`.
No personal access token, GitHub App credential, or long-lived repository
credential is introduced.

The workflow keeps repository permissions read-only:

```yaml
permissions:
  contents: read
  actions: read
  pull-requests: read
  checks: read
  statuses: read
  id-token: write
```

`id-token: write` is retained only for the existing Google Workload Identity
Federation authentication used by the other audit collectors. The GitHub
metadata collector does not use it and does not request write access to
repository contents, pull requests, workflows, issues, deployments, releases,
labels, environments, or artifacts.

## Official GitHub Inputs

The collector uses GitHub Actions context from environment variables:

- `GITHUB_REPOSITORY`
- `GITHUB_RUN_ID`
- `GITHUB_RUN_ATTEMPT`
- `GITHUB_SHA`
- `GITHUB_REF`
- `GITHUB_REF_NAME`
- `GITHUB_EVENT_NAME`
- `GITHUB_WORKFLOW`
- `GITHUB_JOB`
- `GITHUB_ACTOR`
- `GITHUB_SERVER_URL`
- `GITHUB_API_URL`

It uses these read-only GitHub REST API endpoints:

```text
GET /repos/{owner}/{repo}
GET /repos/{owner}/{repo}/commits/{default_branch}
GET /repos/{owner}/{repo}/pulls?state=open&per_page=100
GET /repos/{owner}/{repo}/actions/runs?per_page={configured_maximum}
GET /repos/{owner}/{repo}/commits/{sha}/status
GET /repos/{owner}/{repo}/commits/{sha}/check-runs?per_page=100
GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts?per_page=100
```

The collector does not call workflow dispatch, rerun, cancel, pull request
update, issue, label, release, deployment, environment, artifact download, or
artifact delete endpoints.

## Configuration

| Name | Required | Purpose |
| --- | --- | --- |
| `GITHUB_TOKEN` | Yes for API requests | Existing GitHub Actions token used for read-only GitHub REST API calls. |
| `GITHUB_REPOSITORY` | Yes for API requests | Repository full name from GitHub Actions context. |
| `GITHUB_REPOSITORY_CI_METADATA_MAX_WORKFLOW_RUNS` | Yes for workflow-run requests | Explicit maximum recent workflow runs to request. Allowed range: `0-100`. |

If `GITHUB_REPOSITORY_CI_METADATA_MAX_WORKFLOW_RUNS` is missing or invalid, the
collector still writes machine-readable output, skips recent workflow-run and
artifact collection, and records the skipped reason in
`collectionStatuses.recentWorkflowRuns` and `configuredLimits.workflowRuns`.

A value of `0` disables workflow-run and artifact requests while keeping the
rest of the collector active.

## Collected Fields

The collector preserves objective values returned by GitHub or explicitly
available from GitHub Actions context.

Repository metadata includes:

- full name
- visibility
- private flag
- default branch
- repository URL
- API URL
- created, updated, and pushed timestamps

Current workflow context includes:

- repository
- repository owner and ID when available
- current workflow run ID and attempt
- current commit SHA
- current ref and ref name
- event name
- workflow name
- job name
- actor
- GitHub server and API URLs

Default branch head metadata includes:

- commit SHA
- commit URL and API URL
- commit message
- Git author and committer identity and dates
- GitHub author and committer login metadata when returned

Open pull request metadata includes:

- number
- title
- state
- draft status
- author login
- base branch
- head branch
- head SHA
- created and updated timestamps
- mergeable and mergeable state only if directly returned
- requested reviewers only if directly returned
- labels only if directly returned

Workflow-run metadata includes:

- workflow run ID
- workflow name
- display title
- event
- status
- conclusion
- head branch
- head SHA
- run number
- run attempt
- created and updated timestamps
- run URL
- API URL
- workflow ID and workflow URL

Commit status and check-run metadata is collected for the current audit commit
and the default-branch head commit when their SHAs are available. It includes:

- combined commit status state
- individual status contexts
- status target URL, description, created timestamp, and updated timestamp
- check-run name
- check-run status
- check-run conclusion
- check-run started and completed timestamps
- check-run details URL
- check-run HTML URL
- check suite and GitHub App metadata when returned

Artifact metadata is collected for configured recent workflow runs and includes:

- artifact ID
- name
- size in bytes
- expired status
- created timestamp
- expiration timestamp
- workflow run ID, run URL, and head SHA association

Artifact contents are not downloaded.

## Output Schema

The collector writes:

```text
out/audit-bundle/github-repository-ci-metadata.json
```

It also merges the same object into:

```text
out/audit-bundle/audit-bundle.json
```

under the top-level key `githubRepositoryCiMetadata`. Existing audit bundle
keys are preserved.

Top-level fields:

```json
{
  "generatedAt": "2026-07-22T00:00:00.000Z",
  "collectorVersion": "1.0.0",
  "repository": {},
  "currentWorkflowContext": {},
  "defaultBranchHead": {},
  "openPullRequests": [],
  "recentWorkflowRuns": [],
  "commitStatuses": {
    "currentAuditCommit": {},
    "defaultBranchHead": {}
  },
  "checkRuns": {
    "currentAuditCommit": {},
    "defaultBranchHead": {}
  },
  "artifacts": [],
  "configuredLimits": {
    "workflowRuns": {
      "envVar": "GITHUB_REPOSITORY_CI_METADATA_MAX_WORKFLOW_RUNS",
      "value": 10,
      "status": "configured",
      "reason": null,
      "allowedRange": "0-100"
    }
  },
  "collectionStatuses": {},
  "requestErrors": [],
  "warnings": [],
  "summaryCounts": {}
}
```

`summaryCounts` contains counts only. It does not classify repository health,
CI quality, pull request risk, or urgency.

## Failure Isolation

Each endpoint category is collected independently. A pull-request endpoint
failure does not erase workflow-run metadata. An artifact failure for one
workflow run does not erase artifacts from other workflow runs. Commit status
and check-run failures are recorded independently for the current audit commit
and the default-branch head.

Failures are recorded in `requestErrors` with:

- category
- endpoint method and URL
- HTTP status when available
- error message
- response body when available

Missing or invalid required GitHub configuration is recorded as a
machine-readable `configuration` request error. Authentication or repository
access failures are not hidden; GitHub's returned status and body are preserved
in `requestErrors`.

## API Limitations

- Recent workflow-run collection uses one configured `per_page` request with a
  maximum of `100`. The collector records when GitHub reports more total runs
  than were returned.
- Check-run and artifact collection use the first GitHub API page with
  `per_page=100` and record a warning if GitHub reports more results.
- The pull-request list endpoint may not include mergeability fields. The
  collector records `null` unless those fields are directly returned.
- GitHub Actions context values are only as complete as the workflow environment
  provides.

## Safety Boundary

This collector performs read-only evidence collection. It does not:

- push commits
- create branches
- create, update, close, or merge pull requests
- rerun, cancel, or dispatch workflows
- delete artifacts
- download artifact contents
- modify repository settings
- modify labels, issues, releases, deployments, or environments
- modify production website files
- call the OpenAI Responses API
- invoke Codex implementation automation
- generate AI recommendations
