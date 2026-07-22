#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COLLECTOR_VERSION = "1.0.0";
const GITHUB_API_VERSION = "2022-11-28";
const MAX_WORKFLOW_RUNS_ENV_VAR =
  "GITHUB_REPOSITORY_CI_METADATA_MAX_WORKFLOW_RUNS";
const MAX_WORKFLOW_RUNS_UPPER_BOUND = 100;
const REQUEST_TIMEOUT_MS = 30_000;
const USER_AGENT =
  "JapanRemoteGuide-DailySiteAudit/1.0 (read-only GitHub metadata)";

class CollectionError extends Error {}

class GitHubRequestError extends Error {
  constructor({ endpoint, status, body, message }) {
    super(message);
    this.endpoint = endpoint;
    this.status = status;
    this.body = body;
  }
}

export async function main({
  argv = process.argv,
  env = process.env,
  fetchImpl = fetch,
  now = () => new Date(),
} = {}) {
  const outputDir = argv[2];

  if (!outputDir) {
    throw new CollectionError(
      "Missing output directory argument. Usage: node scripts/collect-github-repository-ci-metadata.mjs out/audit-bundle",
    );
  }

  const result = await collectAndWriteGithubRepositoryCiMetadata({
    outputDir,
    env,
    fetchImpl,
    now,
  });

  const skipped = Object.values(result.collectionStatuses).filter(
    (status) => status.status === "skipped",
  );

  console.log(
    [
      `Collected GitHub repository and CI metadata for ${result.currentWorkflowContext.repository ?? "(unknown repository)"}.`,
      `Open PRs: ${result.summaryCounts.openPullRequests}.`,
      `Recent workflow runs: ${result.summaryCounts.recentWorkflowRuns}.`,
      `Request errors: ${result.summaryCounts.requestErrors}.`,
      skipped.length
        ? `Skipped categories: ${skipped.map((status) => status.category).join(", ")}.`
        : "",
    ]
      .filter(Boolean)
      .join(" "),
  );
}

export async function collectAndWriteGithubRepositoryCiMetadata({
  outputDir,
  env = process.env,
  fetchImpl = fetch,
  now = () => new Date(),
} = {}) {
  if (!outputDir) {
    throw new CollectionError("Missing output directory for GitHub metadata output.");
  }

  const result = await collectGithubRepositoryCiMetadata({
    env,
    fetchImpl,
    now,
  });

  await mkdir(outputDir, { recursive: true });
  await writeJson(
    path.join(outputDir, "github-repository-ci-metadata.json"),
    result,
  );
  await upsertAuditBundle(outputDir, result);

  return result;
}

export async function collectGithubRepositoryCiMetadata({
  env = process.env,
  fetchImpl = fetch,
  now = () => new Date(),
} = {}) {
  const generatedAt = now().toISOString();
  const configuredWorkflowRunsMaximum = parseConfiguredWorkflowRunsMaximum(
    env[MAX_WORKFLOW_RUNS_ENV_VAR],
  );
  const currentWorkflowContext = buildCurrentWorkflowContext(env);
  const result = buildEmptyResult({
    configuredWorkflowRunsMaximum,
    currentWorkflowContext,
    generatedAt,
  });
  const configuration = readConfiguration(env);

  if (configuration.errors.length > 0) {
    for (const category of Object.keys(result.collectionStatuses)) {
      result.collectionStatuses[category] = skippedStatus(
        category,
        "missing_or_invalid_github_configuration",
      );
    }
    result.requestErrors.push({
      category: "configuration",
      endpoint: null,
      status: null,
      error: "missing_or_invalid_github_configuration",
      details: configuration.errors,
    });
    result.warnings.push(
      "GitHub repository and CI metadata collection skipped because required GitHub configuration was missing or invalid.",
    );
    finalizeSummaryCounts(result);
    return result;
  }

  const client = createGitHubClient({
    apiBaseUrl: configuration.apiBaseUrl,
    fetchImpl,
    token: configuration.token,
  });
  const repoPath = createRepositoryPathBuilder(configuration.repositoryFullName);

  const repositoryResponse = await collectRequest({
    category: "repository",
    endpoint: repoPath(""),
    result,
    request: () => client.get(repoPath("")),
  });

  if (repositoryResponse) {
    result.repository = normalizeRepository(repositoryResponse);
  }

  const defaultBranch = result.repository?.defaultBranch ?? null;

  if (defaultBranch) {
    const defaultBranchHeadResponse = await collectRequest({
      category: "defaultBranchHead",
      endpoint: repoPath(`/commits/${encodeURIComponent(defaultBranch)}`),
      result,
      request: () =>
        client.get(repoPath(`/commits/${encodeURIComponent(defaultBranch)}`)),
    });

    if (defaultBranchHeadResponse) {
      result.defaultBranchHead = normalizeCommit(defaultBranchHeadResponse);
    }
  } else {
    result.collectionStatuses.defaultBranchHead = skippedStatus(
      "defaultBranchHead",
      "missing_default_branch",
    );
    result.warnings.push(
      "Default branch head collection skipped because the repository default branch was unavailable.",
    );
  }

  const pullRequestsResponse = await collectRequest({
    category: "openPullRequests",
    endpoint: repoPath("/pulls"),
    result,
    request: () =>
      client.get(repoPath("/pulls"), {
        state: "open",
        per_page: "100",
      }),
  });

  if (pullRequestsResponse) {
    result.openPullRequests = toArray(pullRequestsResponse)
      .map(normalizePullRequest)
      .sort((a, b) => a.number - b.number);
  }

  await collectRecentWorkflowRuns({
    client,
    configuredWorkflowRunsMaximum,
    repoPath,
    result,
  });

  await collectCommitStatusAndChecks({
    client,
    currentWorkflowContext,
    defaultBranchHead: result.defaultBranchHead,
    repoPath,
    result,
  });

  await collectArtifacts({
    client,
    repoPath,
    result,
  });

  finalizeSummaryCounts(result);
  return result;
}

function readConfiguration(env) {
  const errors = [];
  const repositoryValidation = parseRepositoryFullName(env.GITHUB_REPOSITORY);
  const apiBaseUrlValidation = parseApiBaseUrl(env.GITHUB_API_URL);
  const token = stringOrNull(env.GITHUB_TOKEN);

  if (!repositoryValidation.ok) {
    errors.push({
      envVar: "GITHUB_REPOSITORY",
      reason: repositoryValidation.reason,
    });
  }

  if (!apiBaseUrlValidation.ok) {
    errors.push({
      envVar: "GITHUB_API_URL",
      reason: apiBaseUrlValidation.reason,
    });
  }

  if (!token) {
    errors.push({
      envVar: "GITHUB_TOKEN",
      reason: "missing_github_token",
    });
  }

  return {
    apiBaseUrl: apiBaseUrlValidation.value,
    errors,
    repositoryFullName: repositoryValidation.value,
    token,
  };
}

function buildCurrentWorkflowContext(env) {
  const repository = stringOrNull(env.GITHUB_REPOSITORY);
  const serverUrl = stringOrNull(env.GITHUB_SERVER_URL) ?? "https://github.com";

  return {
    repository,
    repositoryId: stringOrNull(env.GITHUB_REPOSITORY_ID),
    repositoryOwner: stringOrNull(env.GITHUB_REPOSITORY_OWNER),
    repositoryUrl: repository ? `${serverUrl.replace(/\/$/, "")}/${repository}` : null,
    serverUrl,
    apiUrl: stringOrNull(env.GITHUB_API_URL) ?? "https://api.github.com",
    runId: stringOrNull(env.GITHUB_RUN_ID),
    runAttempt: stringOrNull(env.GITHUB_RUN_ATTEMPT),
    currentCommitSha: stringOrNull(env.GITHUB_SHA),
    ref: stringOrNull(env.GITHUB_REF),
    refName: stringOrNull(env.GITHUB_REF_NAME),
    eventName: stringOrNull(env.GITHUB_EVENT_NAME),
    workflowName: stringOrNull(env.GITHUB_WORKFLOW),
    jobName: stringOrNull(env.GITHUB_JOB),
    actor: stringOrNull(env.GITHUB_ACTOR),
  };
}

function buildEmptyResult({
  configuredWorkflowRunsMaximum,
  currentWorkflowContext,
  generatedAt,
}) {
  return {
    generatedAt,
    collectorVersion: COLLECTOR_VERSION,
    repository: null,
    currentWorkflowContext,
    defaultBranchHead: null,
    openPullRequests: [],
    recentWorkflowRuns: [],
    commitStatuses: {
      currentAuditCommit: null,
      defaultBranchHead: null,
    },
    checkRuns: {
      currentAuditCommit: null,
      defaultBranchHead: null,
    },
    artifacts: [],
    configuredLimits: {
      workflowRuns: configuredWorkflowRunsMaximum,
    },
    collectionStatuses: {
      repository: pendingStatus("repository"),
      defaultBranchHead: pendingStatus("defaultBranchHead"),
      openPullRequests: pendingStatus("openPullRequests"),
      recentWorkflowRuns: pendingStatus("recentWorkflowRuns"),
      currentAuditCommitStatus: pendingStatus("currentAuditCommitStatus"),
      defaultBranchHeadStatus: pendingStatus("defaultBranchHeadStatus"),
      currentAuditCommitCheckRuns: pendingStatus("currentAuditCommitCheckRuns"),
      defaultBranchHeadCheckRuns: pendingStatus("defaultBranchHeadCheckRuns"),
      artifacts: pendingStatus("artifacts"),
    },
    requestErrors: [],
    warnings: [],
    summaryCounts: {},
  };
}

async function collectRecentWorkflowRuns({
  client,
  configuredWorkflowRunsMaximum,
  repoPath,
  result,
}) {
  if (configuredWorkflowRunsMaximum.status !== "configured") {
    result.collectionStatuses.recentWorkflowRuns = skippedStatus(
      "recentWorkflowRuns",
      configuredWorkflowRunsMaximum.reason,
    );
    result.collectionStatuses.artifacts = skippedStatus(
      "artifacts",
      "recent_workflow_runs_not_collected",
    );
    result.warnings.push(
      "Recent workflow run and artifact collection skipped because GITHUB_REPOSITORY_CI_METADATA_MAX_WORKFLOW_RUNS is not configured with a valid value.",
    );
    return;
  }

  if (configuredWorkflowRunsMaximum.value === 0) {
    result.collectionStatuses.recentWorkflowRuns = skippedStatus(
      "recentWorkflowRuns",
      "configured_maximum_is_zero",
    );
    result.collectionStatuses.artifacts = skippedStatus(
      "artifacts",
      "recent_workflow_runs_not_collected",
    );
    return;
  }

  const response = await collectRequest({
    category: "recentWorkflowRuns",
    endpoint: repoPath("/actions/runs"),
    result,
    request: () =>
      client.get(repoPath("/actions/runs"), {
        per_page: String(configuredWorkflowRunsMaximum.value),
      }),
  });

  if (!response) {
    return;
  }

  const workflowRuns = toArray(response.workflow_runs)
    .map(normalizeWorkflowRun)
    .sort((a, b) => compareDescendingDates(a.createdAt, b.createdAt));

  result.recentWorkflowRuns = workflowRuns;
  result.collectionStatuses.recentWorkflowRuns = collectedStatus(
    "recentWorkflowRuns",
    {
      requestedMaximum: configuredWorkflowRunsMaximum.value,
      returnedCount: workflowRuns.length,
      totalCount: response.total_count ?? null,
    },
  );

  if (
    Number.isSafeInteger(response.total_count) &&
    response.total_count > workflowRuns.length
  ) {
    result.warnings.push(
      `Workflow run collection limited to configured maximum ${configuredWorkflowRunsMaximum.value}; GitHub reported ${response.total_count} total run(s).`,
    );
  }
}

async function collectCommitStatusAndChecks({
  client,
  currentWorkflowContext,
  defaultBranchHead,
  repoPath,
  result,
}) {
  const currentCommitSha = currentWorkflowContext.currentCommitSha;

  if (currentCommitSha) {
    result.commitStatuses.currentAuditCommit = await collectCombinedStatus({
      category: "currentAuditCommitStatus",
      client,
      repoPath,
      sha: currentCommitSha,
      target: "currentAuditCommit",
      result,
    });
    result.checkRuns.currentAuditCommit = await collectCheckRuns({
      category: "currentAuditCommitCheckRuns",
      client,
      repoPath,
      sha: currentCommitSha,
      target: "currentAuditCommit",
      result,
    });
  } else {
    result.collectionStatuses.currentAuditCommitStatus = skippedStatus(
      "currentAuditCommitStatus",
      "missing_current_commit_sha",
    );
    result.collectionStatuses.currentAuditCommitCheckRuns = skippedStatus(
      "currentAuditCommitCheckRuns",
      "missing_current_commit_sha",
    );
    result.warnings.push(
      "Current audit commit status and check-run collection skipped because GITHUB_SHA was unavailable.",
    );
  }

  if (defaultBranchHead?.sha) {
    result.commitStatuses.defaultBranchHead = await collectCombinedStatus({
      category: "defaultBranchHeadStatus",
      client,
      repoPath,
      sha: defaultBranchHead.sha,
      target: "defaultBranchHead",
      result,
    });
    result.checkRuns.defaultBranchHead = await collectCheckRuns({
      category: "defaultBranchHeadCheckRuns",
      client,
      repoPath,
      sha: defaultBranchHead.sha,
      target: "defaultBranchHead",
      result,
    });
  } else {
    result.collectionStatuses.defaultBranchHeadStatus = skippedStatus(
      "defaultBranchHeadStatus",
      "missing_default_branch_head_sha",
    );
    result.collectionStatuses.defaultBranchHeadCheckRuns = skippedStatus(
      "defaultBranchHeadCheckRuns",
      "missing_default_branch_head_sha",
    );
  }
}

async function collectCombinedStatus({
  category,
  client,
  repoPath,
  sha,
  target,
  result,
}) {
  const response = await collectRequest({
    category,
    endpoint: repoPath(`/commits/${encodeURIComponent(sha)}/status`),
    result,
    request: () => client.get(repoPath(`/commits/${encodeURIComponent(sha)}/status`)),
  });

  return response ? normalizeCombinedStatus(response, { sha, target }) : null;
}

async function collectCheckRuns({
  category,
  client,
  repoPath,
  sha,
  target,
  result,
}) {
  const response = await collectRequest({
    category,
    endpoint: repoPath(`/commits/${encodeURIComponent(sha)}/check-runs`),
    result,
    request: () =>
      client.get(repoPath(`/commits/${encodeURIComponent(sha)}/check-runs`), {
        per_page: "100",
      }),
  });

  if (!response) {
    return null;
  }

  const checkRuns = toArray(response.check_runs).map(normalizeCheckRun);

  if (
    Number.isSafeInteger(response.total_count) &&
    response.total_count > checkRuns.length
  ) {
    result.warnings.push(
      `${target} check-run collection returned ${checkRuns.length} of ${response.total_count} check run(s) from the first GitHub API page.`,
    );
  }

  return {
    target,
    sha,
    totalCount: response.total_count ?? checkRuns.length,
    checkRuns,
  };
}

async function collectArtifacts({ client, repoPath, result }) {
  if (result.collectionStatuses.artifacts.status === "skipped") {
    return;
  }

  if (result.recentWorkflowRuns.length === 0) {
    result.collectionStatuses.artifacts = collectedStatus("artifacts", {
      workflowRunCount: 0,
      returnedCount: 0,
    });
    return;
  }

  const artifacts = [];

  for (const workflowRun of result.recentWorkflowRuns) {
    const response = await collectRequest({
      category: "artifacts",
      endpoint: repoPath(`/actions/runs/${workflowRun.id}/artifacts`),
      result,
      request: () =>
        client.get(repoPath(`/actions/runs/${workflowRun.id}/artifacts`), {
          per_page: "100",
        }),
    });

    if (!response) {
      continue;
    }

    const runArtifacts = toArray(response.artifacts).map((artifact) =>
      normalizeArtifact(artifact, workflowRun),
    );
    artifacts.push(...runArtifacts);

    if (
      Number.isSafeInteger(response.total_count) &&
      response.total_count > runArtifacts.length
    ) {
      result.warnings.push(
        `Artifact collection for workflow run ${workflowRun.id} returned ${runArtifacts.length} of ${response.total_count} artifact(s) from the first GitHub API page.`,
      );
    }
  }

  result.artifacts = artifacts.sort(
    (a, b) =>
      String(a.workflowRunId).localeCompare(String(b.workflowRunId)) ||
      String(a.name).localeCompare(String(b.name)),
  );
  result.collectionStatuses.artifacts = collectedStatus("artifacts", {
    workflowRunCount: result.recentWorkflowRuns.length,
    returnedCount: result.artifacts.length,
  });
}

async function collectRequest({ category, endpoint, request, result }) {
  try {
    const response = await request();
    result.collectionStatuses[category] = collectedStatus(category);
    return response;
  } catch (error) {
    result.collectionStatuses[category] = failedStatus(category);
    result.requestErrors.push(normalizeRequestError(error, category, endpoint));
    return null;
  }
}

function createGitHubClient({ apiBaseUrl, fetchImpl, token }) {
  return {
    async get(pathname, searchParams = {}) {
      const url = new URL(pathname.replace(/^\//, ""), ensureTrailingSlash(apiBaseUrl));

      for (const [key, value] of Object.entries(searchParams)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, value);
        }
      }

      const endpoint = {
        method: "GET",
        url: url.href,
        path: `/${pathname.replace(/^\//, "")}`,
      };
      const response = await fetchImpl(url.href, {
        method: "GET",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "user-agent": USER_AGENT,
          "x-github-api-version": GITHUB_API_VERSION,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const body = await readJsonResponse(response);

      if (!response.ok) {
        throw new GitHubRequestError({
          endpoint,
          status: response.status,
          body,
          message: describeGitHubError(body) || `GitHub API HTTP ${response.status}`,
        });
      }

      return body;
    },
  };
}

function createRepositoryPathBuilder(repositoryFullName) {
  const [owner, repo] = repositoryFullName.split("/");
  const encodedBase = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  return (suffix = "") => `${encodedBase}${suffix}`;
}

function normalizeRepository(repository) {
  return {
    fullName: repository.full_name ?? null,
    visibility: repository.visibility ?? null,
    private: repository.private ?? null,
    defaultBranch: repository.default_branch ?? null,
    repositoryUrl: repository.html_url ?? null,
    apiUrl: repository.url ?? null,
    createdAt: repository.created_at ?? null,
    updatedAt: repository.updated_at ?? null,
    pushedAt: repository.pushed_at ?? null,
  };
}

function normalizeCommit(commit) {
  return {
    sha: commit.sha ?? null,
    htmlUrl: commit.html_url ?? null,
    apiUrl: commit.url ?? null,
    commit: {
      message: commit.commit?.message ?? null,
      author: normalizeGitIdentity(commit.commit?.author),
      committer: normalizeGitIdentity(commit.commit?.committer),
      treeSha: commit.commit?.tree?.sha ?? null,
    },
    author: normalizeUser(commit.author),
    committer: normalizeUser(commit.committer),
  };
}

function normalizePullRequest(pullRequest) {
  return {
    number: pullRequest.number ?? null,
    title: pullRequest.title ?? null,
    state: pullRequest.state ?? null,
    draft: pullRequest.draft ?? null,
    author: normalizeUser(pullRequest.user),
    baseBranch: pullRequest.base?.ref ?? null,
    headBranch: pullRequest.head?.ref ?? null,
    headSha: pullRequest.head?.sha ?? null,
    createdAt: pullRequest.created_at ?? null,
    updatedAt: pullRequest.updated_at ?? null,
    mergeable: Object.hasOwn(pullRequest, "mergeable")
      ? pullRequest.mergeable
      : null,
    mergeableState: Object.hasOwn(pullRequest, "mergeable_state")
      ? pullRequest.mergeable_state
      : null,
    requestedReviewers: toArray(pullRequest.requested_reviewers).map(
      normalizeUser,
    ),
    labels: toArray(pullRequest.labels).map(normalizeLabel),
    htmlUrl: pullRequest.html_url ?? null,
    apiUrl: pullRequest.url ?? null,
  };
}

function normalizeWorkflowRun(workflowRun) {
  return {
    id: workflowRun.id ?? null,
    workflowName: workflowRun.name ?? null,
    displayTitle: workflowRun.display_title ?? null,
    event: workflowRun.event ?? null,
    status: workflowRun.status ?? null,
    conclusion: workflowRun.conclusion ?? null,
    headBranch: workflowRun.head_branch ?? null,
    headSha: workflowRun.head_sha ?? null,
    runNumber: workflowRun.run_number ?? null,
    runAttempt: workflowRun.run_attempt ?? null,
    createdAt: workflowRun.created_at ?? null,
    updatedAt: workflowRun.updated_at ?? null,
    runUrl: workflowRun.html_url ?? null,
    apiUrl: workflowRun.url ?? null,
    workflowId: workflowRun.workflow_id ?? null,
    workflowUrl: workflowRun.workflow_url ?? null,
  };
}

function normalizeCombinedStatus(status, { sha, target }) {
  return {
    target,
    sha: status.sha ?? sha,
    state: status.state ?? null,
    totalCount: status.total_count ?? toArray(status.statuses).length,
    repositoryUrl: status.repository?.html_url ?? null,
    commitUrl: status.commit_url ?? null,
    statuses: toArray(status.statuses).map((contextStatus) => ({
      id: contextStatus.id ?? null,
      context: contextStatus.context ?? null,
      state: contextStatus.state ?? null,
      description: contextStatus.description ?? null,
      targetUrl: contextStatus.target_url ?? null,
      createdAt: contextStatus.created_at ?? null,
      updatedAt: contextStatus.updated_at ?? null,
      apiUrl: contextStatus.url ?? null,
    })),
  };
}

function normalizeCheckRun(checkRun) {
  return {
    id: checkRun.id ?? null,
    name: checkRun.name ?? null,
    status: checkRun.status ?? null,
    conclusion: checkRun.conclusion ?? null,
    startedAt: checkRun.started_at ?? null,
    completedAt: checkRun.completed_at ?? null,
    detailsUrl: checkRun.details_url ?? null,
    htmlUrl: checkRun.html_url ?? null,
    apiUrl: checkRun.url ?? null,
    checkSuiteId: checkRun.check_suite?.id ?? null,
    app: checkRun.app
      ? {
          id: checkRun.app.id ?? null,
          slug: checkRun.app.slug ?? null,
          name: checkRun.app.name ?? null,
        }
      : null,
  };
}

function normalizeArtifact(artifact, workflowRun) {
  return {
    artifactId: artifact.id ?? null,
    name: artifact.name ?? null,
    sizeInBytes: artifact.size_in_bytes ?? null,
    expired: artifact.expired ?? null,
    createdAt: artifact.created_at ?? null,
    expiresAt: artifact.expires_at ?? null,
    workflowRunId: workflowRun.id ?? null,
    workflowRunUrl: workflowRun.runUrl ?? null,
    workflowRunHeadSha: workflowRun.headSha ?? null,
    apiUrl: artifact.url ?? null,
  };
}

function normalizeGitIdentity(identity) {
  if (!identity) {
    return null;
  }

  return {
    name: identity.name ?? null,
    email: identity.email ?? null,
    date: identity.date ?? null,
  };
}

function normalizeUser(user) {
  if (!user) {
    return null;
  }

  return {
    login: user.login ?? null,
    id: user.id ?? null,
    type: user.type ?? null,
    htmlUrl: user.html_url ?? null,
  };
}

function normalizeLabel(label) {
  return {
    id: label.id ?? null,
    name: label.name ?? null,
    color: label.color ?? null,
    description: label.description ?? null,
  };
}

function normalizeRequestError(error, category, fallbackEndpoint) {
  if (error instanceof GitHubRequestError) {
    return {
      category,
      endpoint: error.endpoint,
      status: error.status,
      error: error.message,
      response: error.body,
    };
  }

  return {
    category,
    endpoint: {
      method: "GET",
      path: fallbackEndpoint,
      url: null,
    },
    status: null,
    error: error instanceof Error ? error.message : String(error),
    response: null,
  };
}

function parseRepositoryFullName(rawValue) {
  const value = stringOrNull(rawValue);

  if (!value) {
    return {
      ok: false,
      value: null,
      reason: "missing_repository_full_name",
    };
  }

  if (!/^[^/\s]+\/[^/\s]+$/.test(value)) {
    return {
      ok: false,
      value: null,
      reason: "invalid_repository_full_name",
    };
  }

  return {
    ok: true,
    value,
    reason: null,
  };
}

function parseApiBaseUrl(rawValue) {
  const value = stringOrNull(rawValue) ?? "https://api.github.com";

  try {
    const url = new URL(value);

    if (!["http:", "https:"].includes(url.protocol)) {
      return {
        ok: false,
        value: null,
        reason: "invalid_github_api_url_protocol",
      };
    }

    url.hash = "";
    url.search = "";

    return {
      ok: true,
      value: url.href,
      reason: null,
    };
  } catch {
    return {
      ok: false,
      value: null,
      reason: "invalid_github_api_url",
    };
  }
}

export function parseConfiguredWorkflowRunsMaximum(rawValue) {
  const trimmed = rawValue === undefined || rawValue === null
    ? ""
    : String(rawValue).trim();

  if (!trimmed) {
    return {
      envVar: MAX_WORKFLOW_RUNS_ENV_VAR,
      value: null,
      status: "missing",
      reason: "missing_configured_maximum",
      allowedRange: `0-${MAX_WORKFLOW_RUNS_UPPER_BOUND}`,
    };
  }

  if (!/^\d+$/.test(trimmed)) {
    return {
      envVar: MAX_WORKFLOW_RUNS_ENV_VAR,
      value: null,
      status: "invalid",
      reason: "invalid_configured_maximum",
      allowedRange: `0-${MAX_WORKFLOW_RUNS_UPPER_BOUND}`,
    };
  }

  const value = Number(trimmed);

  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_WORKFLOW_RUNS_UPPER_BOUND
  ) {
    return {
      envVar: MAX_WORKFLOW_RUNS_ENV_VAR,
      value,
      status: "invalid",
      reason: "configured_maximum_outside_allowed_range",
      allowedRange: `0-${MAX_WORKFLOW_RUNS_UPPER_BOUND}`,
    };
  }

  return {
    envVar: MAX_WORKFLOW_RUNS_ENV_VAR,
    value,
    status: "configured",
    reason: null,
    allowedRange: `0-${MAX_WORKFLOW_RUNS_UPPER_BOUND}`,
  };
}

function finalizeSummaryCounts(result) {
  const currentCheckRuns =
    result.checkRuns.currentAuditCommit?.checkRuns?.length ?? 0;
  const defaultBranchCheckRuns =
    result.checkRuns.defaultBranchHead?.checkRuns?.length ?? 0;
  const currentStatuses =
    result.commitStatuses.currentAuditCommit?.statuses?.length ?? 0;
  const defaultBranchStatuses =
    result.commitStatuses.defaultBranchHead?.statuses?.length ?? 0;

  result.summaryCounts = {
    repositoryCollected: result.repository ? 1 : 0,
    defaultBranchHeadCollected: result.defaultBranchHead ? 1 : 0,
    openPullRequests: result.openPullRequests.length,
    recentWorkflowRuns: result.recentWorkflowRuns.length,
    commitStatusTargets: [
      result.commitStatuses.currentAuditCommit,
      result.commitStatuses.defaultBranchHead,
    ].filter(Boolean).length,
    statusContexts: currentStatuses + defaultBranchStatuses,
    checkRunTargets: [
      result.checkRuns.currentAuditCommit,
      result.checkRuns.defaultBranchHead,
    ].filter(Boolean).length,
    checkRuns: currentCheckRuns + defaultBranchCheckRuns,
    artifacts: result.artifacts.length,
    requestErrors: result.requestErrors.length,
    warnings: result.warnings.length,
  };
}

function pendingStatus(category) {
  return {
    category,
    status: "pending",
    reason: null,
  };
}

function collectedStatus(category, details = {}) {
  return {
    category,
    status: "collected",
    reason: null,
    ...details,
  };
}

function skippedStatus(category, reason) {
  return {
    category,
    status: "skipped",
    reason,
  };
}

function failedStatus(category) {
  return {
    category,
    status: "failed",
    reason: "request_failed",
  };
}

function compareDescendingDates(a, b) {
  return String(b ?? "").localeCompare(String(a ?? ""));
}

function stringOrNull(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const stringValue = String(value).trim();
  return stringValue || null;
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

async function readJsonResponse(response) {
  const text = await response.text();

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function describeGitHubError(body) {
  if (typeof body?.message === "string") {
    return body.message;
  }

  if (body?.raw) {
    return body.raw;
  }

  return "";
}

async function upsertAuditBundle(outputDir, githubRepositoryCiMetadata) {
  const auditBundlePath = path.join(outputDir, "audit-bundle.json");
  const auditBundle = await readExistingAuditBundle(auditBundlePath);

  await writeJson(auditBundlePath, {
    ...auditBundle,
    githubRepositoryCiMetadata,
  });
}

async function readExistingAuditBundle(auditBundlePath) {
  let rawBundle;

  try {
    rawBundle = await readFile(auditBundlePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {};
    }

    throw error;
  }

  try {
    return JSON.parse(rawBundle);
  } catch {
    throw new CollectionError(
      `${auditBundlePath} exists but does not contain valid JSON.`,
    );
  }
}

async function writeJson(filePath, data) {
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

const isCli = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isCli) {
  main().catch((error) => {
    if (error instanceof CollectionError) {
      console.error(error.message);
    } else {
      console.error(
        "Unexpected GitHub repository and CI metadata collection failure.",
      );
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exit(1);
  });
}
