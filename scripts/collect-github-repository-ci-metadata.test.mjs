import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectAndWriteGithubRepositoryCiMetadata,
} from "./collect-github-repository-ci-metadata.mjs";

const FIXED_NOW = "2026-07-22T00:00:00.000Z";

test("collects GitHub metadata, upserts audit bundle, and uses only read-only endpoints", async () => {
  const outputDir = await createAuditBundle({
    searchConsole: {
      preserved: true,
    },
  });
  const requests = [];

  try {
    const result = await collectAndWriteGithubRepositoryCiMetadata({
      outputDir,
      env: buildEnv({
        GITHUB_REPOSITORY_CI_METADATA_MAX_WORKFLOW_RUNS: "1",
      }),
      fetchImpl: createMockFetch(successRoutes(), requests),
      now: () => new Date(FIXED_NOW),
    });

    assert.equal(result.generatedAt, FIXED_NOW);
    assert.equal(result.collectorVersion, "1.0.0");
    assert.equal(result.repository.fullName, "owner/repo");
    assert.equal(result.repository.visibility, "private");
    assert.equal(result.repository.defaultBranch, "main");
    assert.equal(result.repository.createdAt, "2026-01-01T00:00:00Z");
    assert.equal(result.currentWorkflowContext.runId, "9001");
    assert.equal(result.currentWorkflowContext.workflowName, "Daily site audit");
    assert.equal(result.defaultBranchHead.sha, "default-sha");
    assert.equal(
      result.defaultBranchHead.commit.message,
      "Update default branch fixture",
    );

    assert.equal(result.openPullRequests.length, 1);
    assert.equal(result.openPullRequests[0].number, 7);
    assert.equal(result.openPullRequests[0].title, "Fixture PR");
    assert.equal(result.openPullRequests[0].draft, true);
    assert.equal(result.openPullRequests[0].author.login, "contributor");
    assert.equal(result.openPullRequests[0].baseBranch, "main");
    assert.equal(result.openPullRequests[0].headBranch, "feature/github-ci");
    assert.equal(result.openPullRequests[0].headSha, "pr-head-sha");
    assert.equal(result.openPullRequests[0].requestedReviewers[0].login, "reviewer");
    assert.equal(result.openPullRequests[0].labels[0].name, "audit");

    assert.equal(result.recentWorkflowRuns.length, 1);
    assert.equal(result.recentWorkflowRuns[0].id, 101);
    assert.equal(result.recentWorkflowRuns[0].workflowName, "Validate site");
    assert.equal(result.recentWorkflowRuns[0].event, "pull_request");
    assert.equal(result.recentWorkflowRuns[0].status, "completed");
    assert.equal(result.recentWorkflowRuns[0].conclusion, "failure");
    assert.equal(result.recentWorkflowRuns[0].runAttempt, 2);
    assert.equal(result.configuredLimits.workflowRuns.value, 1);
    assert.equal(
      requests.some(
        (request) =>
          request.pathname === "/repos/owner/repo/actions/runs" &&
          request.searchParams.get("per_page") === "1",
      ),
      true,
    );

    assert.equal(result.commitStatuses.currentAuditCommit.state, "success");
    assert.equal(
      result.commitStatuses.currentAuditCommit.statuses[0].context,
      "pages/build",
    );
    assert.equal(
      result.commitStatuses.defaultBranchHead.statuses[0].state,
      "pending",
    );
    assert.equal(result.checkRuns.currentAuditCommit.checkRuns[0].name, "HTML");
    assert.equal(
      result.checkRuns.currentAuditCommit.checkRuns[0].conclusion,
      "success",
    );
    assert.equal(
      result.checkRuns.currentAuditCommit.checkRuns[0].detailsUrl,
      "https://github.example/owner/repo/actions/runs/101/job/1",
    );

    assert.equal(result.artifacts.length, 1);
    assert.equal(result.artifacts[0].artifactId, 501);
    assert.equal(result.artifacts[0].name, "audit-bundle");
    assert.equal(result.artifacts[0].expired, false);
    assert.equal(result.artifacts[0].workflowRunId, 101);
    assert.equal(result.summaryCounts.artifacts, 1);

    const auditBundle = await readAuditBundle(outputDir);
    assert.equal(auditBundle.searchConsole.preserved, true);
    assert.equal(
      auditBundle.githubRepositoryCiMetadata.repository.fullName,
      "owner/repo",
    );

    assert.equal(requests.every((request) => request.method === "GET"), true);
    assert.equal(
      requests.some((request) =>
        /\/actions\/workflows\/[^/]+\/dispatches/.test(request.pathname)
      ),
      false,
    );
    assert.equal(
      requests.some((request) => /\/actions\/runs\/\d+\/(rerun|cancel)/.test(request.pathname)),
      false,
    );
    assert.equal(
      requests.some((request) => /\/repos\/owner\/repo\/pulls\/\d+/.test(request.pathname)),
      false,
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("one endpoint failure does not erase successful categories", async () => {
  const outputDir = await createAuditBundle({});
  const routes = successRoutes();

  routes["GET /repos/owner/repo/pulls?state=open&per_page=100"] = {
    status: 500,
    body: {
      message: "Pull request fixture failure",
    },
  };

  try {
    const result = await collectAndWriteGithubRepositoryCiMetadata({
      outputDir,
      env: buildEnv({
        GITHUB_REPOSITORY_CI_METADATA_MAX_WORKFLOW_RUNS: "1",
      }),
      fetchImpl: createMockFetch(routes),
      now: () => new Date(FIXED_NOW),
    });

    assert.equal(result.repository.fullName, "owner/repo");
    assert.equal(result.openPullRequests.length, 0);
    assert.equal(result.recentWorkflowRuns.length, 1);
    assert.equal(result.commitStatuses.currentAuditCommit.state, "success");
    assert.equal(result.checkRuns.currentAuditCommit.checkRuns.length, 1);
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.requestErrors.length, 1);
    assert.equal(result.requestErrors[0].category, "openPullRequests");
    assert.equal(result.requestErrors[0].status, 500);
    assert.equal(result.summaryCounts.requestErrors, 1);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("missing workflow-run maximum skips run and artifact requests with machine-readable status", async () => {
  const outputDir = await createAuditBundle({});
  const requests = [];
  const routes = successRoutes();
  delete routes["GET /repos/owner/repo/actions/runs?per_page=1"];
  delete routes["GET /repos/owner/repo/actions/runs/101/artifacts?per_page=100"];

  try {
    const result = await collectAndWriteGithubRepositoryCiMetadata({
      outputDir,
      env: buildEnv(),
      fetchImpl: createMockFetch(routes, requests),
      now: () => new Date(FIXED_NOW),
    });

    assert.equal(result.configuredLimits.workflowRuns.status, "missing");
    assert.equal(
      result.collectionStatuses.recentWorkflowRuns.status,
      "skipped",
    );
    assert.equal(
      result.collectionStatuses.recentWorkflowRuns.reason,
      "missing_configured_maximum",
    );
    assert.equal(result.collectionStatuses.artifacts.status, "skipped");
    assert.equal(result.recentWorkflowRuns.length, 0);
    assert.equal(result.artifacts.length, 0);
    assert.equal(
      requests.some(
        (request) => request.pathname === "/repos/owner/repo/actions/runs",
      ),
      false,
    );
    assert.equal(result.repository.fullName, "owner/repo");
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("missing required GitHub configuration produces a machine-readable bundle result", async () => {
  const outputDir = await createAuditBundle({
    existing: true,
  });
  const requests = [];

  try {
    const result = await collectAndWriteGithubRepositoryCiMetadata({
      outputDir,
      env: {
        GITHUB_REPOSITORY: "owner/repo",
      },
      fetchImpl: createMockFetch({}, requests),
      now: () => new Date(FIXED_NOW),
    });

    assert.equal(requests.length, 0);
    assert.equal(result.repository, null);
    assert.equal(result.requestErrors.length, 1);
    assert.equal(result.requestErrors[0].category, "configuration");
    assert.deepEqual(
      result.requestErrors[0].details.map((detail) => detail.envVar),
      ["GITHUB_TOKEN"],
    );
    assert.equal(result.summaryCounts.requestErrors, 1);

    const auditBundle = await readAuditBundle(outputDir);
    assert.equal(auditBundle.existing, true);
    assert.equal(
      auditBundle.githubRepositoryCiMetadata.requestErrors[0].category,
      "configuration",
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

function buildEnv(overrides = {}) {
  return {
    GITHUB_API_URL: "https://api.github.test",
    GITHUB_SERVER_URL: "https://github.example",
    GITHUB_REPOSITORY: "owner/repo",
    GITHUB_REPOSITORY_ID: "42",
    GITHUB_REPOSITORY_OWNER: "owner",
    GITHUB_TOKEN: "fixture-token",
    GITHUB_RUN_ID: "9001",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_SHA: "current-sha",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REF_NAME: "main",
    GITHUB_EVENT_NAME: "schedule",
    GITHUB_WORKFLOW: "Daily site audit",
    GITHUB_JOB: "collect-audit-bundle",
    GITHUB_ACTOR: "audit-bot",
    ...overrides,
  };
}

function successRoutes() {
  return {
    "GET /repos/owner/repo": {
      body: {
        full_name: "owner/repo",
        visibility: "private",
        private: true,
        default_branch: "main",
        html_url: "https://github.example/owner/repo",
        url: "https://api.github.test/repos/owner/repo",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-07-21T00:00:00Z",
        pushed_at: "2026-07-21T01:00:00Z",
      },
    },
    "GET /repos/owner/repo/commits/main": {
      body: {
        sha: "default-sha",
        html_url: "https://github.example/owner/repo/commit/default-sha",
        url: "https://api.github.test/repos/owner/repo/commits/default-sha",
        commit: {
          message: "Update default branch fixture",
          author: {
            name: "Default Author",
            email: "author@example.com",
            date: "2026-07-21T00:00:00Z",
          },
          committer: {
            name: "Default Committer",
            email: "committer@example.com",
            date: "2026-07-21T00:01:00Z",
          },
          tree: {
            sha: "tree-sha",
          },
        },
        author: {
          login: "default-author",
          id: 1,
          type: "User",
          html_url: "https://github.example/default-author",
        },
        committer: {
          login: "default-committer",
          id: 2,
          type: "User",
          html_url: "https://github.example/default-committer",
        },
      },
    },
    "GET /repos/owner/repo/pulls?state=open&per_page=100": {
      body: [
        {
          number: 7,
          title: "Fixture PR",
          state: "open",
          draft: true,
          user: {
            login: "contributor",
            id: 3,
            type: "User",
            html_url: "https://github.example/contributor",
          },
          base: {
            ref: "main",
          },
          head: {
            ref: "feature/github-ci",
            sha: "pr-head-sha",
          },
          created_at: "2026-07-20T00:00:00Z",
          updated_at: "2026-07-21T00:00:00Z",
          mergeable_state: "unknown",
          requested_reviewers: [
            {
              login: "reviewer",
              id: 4,
              type: "User",
              html_url: "https://github.example/reviewer",
            },
          ],
          labels: [
            {
              id: 5,
              name: "audit",
              color: "0366d6",
              description: "Audit work",
            },
          ],
          html_url: "https://github.example/owner/repo/pull/7",
          url: "https://api.github.test/repos/owner/repo/pulls/7",
        },
      ],
    },
    "GET /repos/owner/repo/actions/runs?per_page=1": {
      body: {
        total_count: 2,
        workflow_runs: [
          {
            id: 101,
            name: "Validate site",
            display_title: "Validate fixture",
            event: "pull_request",
            status: "completed",
            conclusion: "failure",
            head_branch: "feature/github-ci",
            head_sha: "workflow-head-sha",
            run_number: 33,
            run_attempt: 2,
            created_at: "2026-07-21T01:00:00Z",
            updated_at: "2026-07-21T01:05:00Z",
            html_url: "https://github.example/owner/repo/actions/runs/101",
            url: "https://api.github.test/repos/owner/repo/actions/runs/101",
            workflow_id: 12,
            workflow_url: "https://api.github.test/repos/owner/repo/actions/workflows/12",
          },
        ],
      },
    },
    "GET /repos/owner/repo/commits/current-sha/status": {
      body: combinedStatusFixture({
        sha: "current-sha",
        state: "success",
        contextState: "success",
      }),
    },
    "GET /repos/owner/repo/commits/default-sha/status": {
      body: combinedStatusFixture({
        sha: "default-sha",
        state: "pending",
        contextState: "pending",
      }),
    },
    "GET /repos/owner/repo/commits/current-sha/check-runs?per_page=100": {
      body: checkRunsFixture({
        name: "HTML",
        conclusion: "success",
      }),
    },
    "GET /repos/owner/repo/commits/default-sha/check-runs?per_page=100": {
      body: checkRunsFixture({
        name: "Links",
        conclusion: "neutral",
      }),
    },
    "GET /repos/owner/repo/actions/runs/101/artifacts?per_page=100": {
      body: {
        total_count: 1,
        artifacts: [
          {
            id: 501,
            name: "audit-bundle",
            size_in_bytes: 2048,
            expired: false,
            created_at: "2026-07-21T01:05:00Z",
            expires_at: "2026-08-20T01:05:00Z",
            url: "https://api.github.test/repos/owner/repo/actions/artifacts/501",
          },
        ],
      },
    },
  };
}

function combinedStatusFixture({ sha, state, contextState }) {
  return {
    sha,
    state,
    total_count: 1,
    commit_url: `https://api.github.test/repos/owner/repo/commits/${sha}`,
    repository: {
      html_url: "https://github.example/owner/repo",
    },
    statuses: [
      {
        id: 301,
        context: "pages/build",
        state: contextState,
        description: "Fixture status",
        target_url: "https://github.example/owner/repo/actions/runs/101",
        created_at: "2026-07-21T01:00:00Z",
        updated_at: "2026-07-21T01:02:00Z",
        url: `https://api.github.test/repos/owner/repo/statuses/${sha}`,
      },
    ],
  };
}

function checkRunsFixture({ name, conclusion }) {
  return {
    total_count: 1,
    check_runs: [
      {
        id: 401,
        name,
        status: "completed",
        conclusion,
        started_at: "2026-07-21T01:00:00Z",
        completed_at: "2026-07-21T01:04:00Z",
        details_url: "https://github.example/owner/repo/actions/runs/101/job/1",
        html_url: "https://github.example/owner/repo/runs/401",
        url: "https://api.github.test/repos/owner/repo/check-runs/401",
        check_suite: {
          id: 400,
        },
        app: {
          id: 15368,
          slug: "github-actions",
          name: "GitHub Actions",
        },
      },
    ],
  };
}

function createMockFetch(routes, requests = []) {
  return async (url, options = {}) => {
    const parsedUrl = new URL(url);
    const method = options.method ?? "GET";
    const key = `${method} ${parsedUrl.pathname}${parsedUrl.search}`;

    requests.push({
      method,
      pathname: parsedUrl.pathname,
      search: parsedUrl.search,
      searchParams: parsedUrl.searchParams,
      authorization: options.headers?.authorization ?? null,
    });

    assert.equal(options.headers.authorization, "Bearer fixture-token");
    assert.equal(options.headers.accept, "application/vnd.github+json");

    if (!routes[key]) {
      throw new Error(`Unexpected GitHub API request: ${key}`);
    }

    const route = routes[key];
    return jsonResponse(route.body, {
      status: route.status ?? 200,
    });
  };
}

async function createAuditBundle(bundle) {
  const outputDir = await mkdtemp(path.join(tmpdir(), "github-ci-metadata-"));

  await mkdir(outputDir, { recursive: true });
  await writeFile(
    path.join(outputDir, "audit-bundle.json"),
    `${JSON.stringify(bundle, null, 2)}\n`,
    "utf8",
  );

  return outputDir;
}

async function readAuditBundle(outputDir) {
  return JSON.parse(
    await readFile(path.join(outputDir, "audit-bundle.json"), "utf8"),
  );
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
    },
    status: 200,
    ...init,
  });
}
