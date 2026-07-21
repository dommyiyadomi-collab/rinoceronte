#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_ENV_VARS = ["GOOGLE_SEARCH_CONSOLE_SITE_URL"];
const COLLECTOR_VERSION = "1.0.0";
const SEARCH_CONSOLE_SCOPE =
  "https://www.googleapis.com/auth/webmasters.readonly";
const URL_INSPECTION_API_VERSION = "searchconsole/v1";
const URL_INSPECTION_ENDPOINT =
  "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";
const MAX_TARGETS_ENV_VAR =
  "GOOGLE_SEARCH_CONSOLE_URL_INSPECTION_MAX_TARGETS";
const LANGUAGE_CODE_ENV_VAR =
  "GOOGLE_SEARCH_CONSOLE_URL_INSPECTION_LANGUAGE_CODE";
const DAILY_QUOTA_PER_SITE = 2_000;
const MINUTE_QUOTA_PER_SITE = 600;
const EXPLICIT_DECLINE_ARRAY_KEY = "declineEvidence";

class CollectionError extends Error {}

export async function main({
  argv = process.argv,
  env = process.env,
  fetchImpl = fetch,
  now = () => new Date(),
  fetchAccessTokenImpl = fetchAccessToken,
} = {}) {
  const outputDir = argv[2];

  if (!outputDir) {
    throw new CollectionError(
      "Missing output directory argument. Usage: node scripts/collect-search-console-url-inspection.mjs out/audit-bundle",
    );
  }

  const environment = readEnvironment(env);
  const siteUrl = normalizeSiteUrl(environment.GOOGLE_SEARCH_CONSOLE_SITE_URL);
  const result = await collectAndWriteSearchConsoleUrlInspection({
    outputDir,
    siteUrl,
    configuredMaximumRaw: environment[MAX_TARGETS_ENV_VAR],
    languageCode: environment[LANGUAGE_CODE_ENV_VAR],
    fetchImpl,
    fetchAccessTokenImpl,
    now,
  });

  if (result.targetSelectionStatus.status === "skipped") {
    console.log(
      `Skipped Search Console URL Inspection collection for ${siteUrl}: ${result.targetSelectionStatus.reason}.`,
    );
    return;
  }

  console.log(
    `Collected ${result.inspectionResults.length} Search Console URL Inspection result(s) for ${siteUrl}.`,
  );
}

function readEnvironment(env) {
  const missingEnvVars = REQUIRED_ENV_VARS.filter(
    (envVar) => !env[envVar]?.trim(),
  );

  if (missingEnvVars.length > 0) {
    throw new CollectionError(
      [
        "Google Search Console URL Inspection collection is not configured.",
        "Missing required environment variable(s):",
        ...missingEnvVars.map((envVar) => `  - ${envVar}`),
        "",
        "Set the missing values before collecting the audit bundle.",
        "See docs/search-console-url-inspection.md for the required configuration.",
      ].join("\n"),
    );
  }

  return {
    GOOGLE_SEARCH_CONSOLE_SITE_URL: env.GOOGLE_SEARCH_CONSOLE_SITE_URL,
    [MAX_TARGETS_ENV_VAR]: env[MAX_TARGETS_ENV_VAR],
    [LANGUAGE_CODE_ENV_VAR]: env[LANGUAGE_CODE_ENV_VAR],
  };
}

export async function collectAndWriteSearchConsoleUrlInspection({
  outputDir,
  siteUrl,
  configuredMaximumRaw,
  languageCode = null,
  fetchImpl = fetch,
  fetchAccessTokenImpl = fetchAccessToken,
  now = () => new Date(),
}) {
  if (!outputDir) {
    throw new CollectionError("Missing output directory for URL Inspection output.");
  }

  const generatedAt = now().toISOString();
  const configuredMaximum = parseConfiguredMaximum(configuredMaximumRaw);
  const selectionSource = {
    file: "audit-bundle.json",
    key: "searchConsole.searchAnalytics",
    requirement:
      "explicit page-level current-versus-previous decline evidence",
  };
  const warnings = [];
  let selectedTargets = [];
  let rejectedTargets = [];
  let inspectedUrls = [];
  let inspectionResults = [];
  let requestErrors = [];
  let targetSelectionStatus;

  if (configuredMaximum.status !== "configured") {
    targetSelectionStatus = skippedStatus(configuredMaximum.reason, {
      selectedTargetCount: 0,
      rejectedTargetCount: 0,
    });
  } else if (configuredMaximum.value === 0) {
    targetSelectionStatus = skippedStatus("configured_maximum_is_zero", {
      selectedTargetCount: 0,
      rejectedTargetCount: 0,
    });
  } else {
    const auditBundle = await readExistingAuditBundle(
      path.join(outputDir, "audit-bundle.json"),
    );
    const searchAnalytics = auditBundle.searchConsole?.searchAnalytics;
    const candidates = selectDecliningPageTargets(searchAnalytics);

    if (candidates.length === 0) {
      warnings.push(
        "Search Analytics output did not contain explicit page-level decline evidence.",
      );
      targetSelectionStatus = skippedStatus(
        "insufficient_search_analytics_decline_evidence",
        {
          selectedTargetCount: 0,
          rejectedTargetCount: 0,
        },
      );
    } else {
      const validation = validateInspectionTargets({
        candidates,
        configuredMaximum: configuredMaximum.value,
        siteUrl,
      });
      selectedTargets = validation.selectedTargets;
      rejectedTargets = validation.rejectedTargets;

      if (selectedTargets.length === 0) {
        targetSelectionStatus = skippedStatus("no_valid_targets", {
          selectedTargetCount: 0,
          rejectedTargetCount: rejectedTargets.length,
        });
      } else {
        targetSelectionStatus = {
          status: "selected",
          reason: null,
          selectedTargetCount: selectedTargets.length,
          rejectedTargetCount: rejectedTargets.length,
        };

        const accessToken = await fetchAccessTokenImpl();

        for (const target of selectedTargets) {
          inspectedUrls.push(target.inspectionUrl);
          const inspection = await inspectUrl({
            accessToken,
            fetchImpl,
            inspectionUrl: target.inspectionUrl,
            languageCode,
            siteUrl,
          });

          if (inspection.ok) {
            inspectionResults.push({
              inspectionUrl: target.inspectionUrl,
              response: inspection.body,
            });
          } else {
            requestErrors.push({
              inspectionUrl: target.inspectionUrl,
              status: inspection.status,
              error: inspection.error,
              response: inspection.body,
            });
          }
        }
      }
    }
  }

  const output = {
    generatedAt,
    property: siteUrl,
    collectorVersion: COLLECTOR_VERSION,
    apiVersion: URL_INSPECTION_API_VERSION,
    endpoint: {
      method: "POST",
      url: URL_INSPECTION_ENDPOINT,
      scope: SEARCH_CONSOLE_SCOPE,
    },
    selectionSource,
    targetSelectionStatus,
    configuredMaximum,
    selectedTargets,
    rejectedTargets,
    inspectedUrls,
    inspectionResults,
    requestErrors,
    warnings,
    summaryCounts: buildSummaryCounts({
      selectedTargets,
      rejectedTargets,
      inspectedUrls,
      inspectionResults,
      requestErrors,
      warnings,
    }),
  };

  await mkdir(outputDir, { recursive: true });
  await writeJson(
    path.join(outputDir, "search-console-url-inspection.json"),
    output,
  );
  await upsertAuditBundle(outputDir, output);

  return output;
}

function skippedStatus(reason, { selectedTargetCount, rejectedTargetCount }) {
  return {
    status: "skipped",
    reason,
    selectedTargetCount,
    rejectedTargetCount,
  };
}

function parseConfiguredMaximum(rawValue) {
  const trimmed = rawValue === undefined || rawValue === null
    ? ""
    : String(rawValue).trim();

  if (!trimmed) {
    return {
      envVar: MAX_TARGETS_ENV_VAR,
      value: null,
      status: "missing",
      reason: "missing_configured_maximum",
      allowedRange: `0-${MINUTE_QUOTA_PER_SITE - 1}`,
      quotaContext: quotaContext(),
    };
  }

  if (!/^\d+$/.test(trimmed)) {
    return {
      envVar: MAX_TARGETS_ENV_VAR,
      value: null,
      status: "invalid",
      reason: "invalid_configured_maximum",
      allowedRange: `0-${MINUTE_QUOTA_PER_SITE - 1}`,
      quotaContext: quotaContext(),
    };
  }

  const value = Number(trimmed);

  if (!Number.isSafeInteger(value) || value >= MINUTE_QUOTA_PER_SITE) {
    return {
      envVar: MAX_TARGETS_ENV_VAR,
      value,
      status: "invalid",
      reason: "configured_maximum_exceeds_quota_guard",
      allowedRange: `0-${MINUTE_QUOTA_PER_SITE - 1}`,
      quotaContext: quotaContext(),
    };
  }

  return {
    envVar: MAX_TARGETS_ENV_VAR,
    value,
    status: "configured",
    reason: null,
    allowedRange: `0-${MINUTE_QUOTA_PER_SITE - 1}`,
    quotaContext: quotaContext(),
  };
}

function quotaContext() {
  return {
    source: "project design report",
    perSiteQueriesPerDay: DAILY_QUOTA_PER_SITE,
    perSiteQueriesPerMinute: MINUTE_QUOTA_PER_SITE,
  };
}

export function selectDecliningPageTargets(searchAnalytics) {
  if (!searchAnalytics || typeof searchAnalytics !== "object") {
    return [];
  }

  return selectTargetsFromExplicitDeclineArrays(searchAnalytics).filter(
    (candidate) => candidate.rawUrl,
  );
}

function selectTargetsFromExplicitDeclineArrays(searchAnalytics) {
  const candidates = [];
  const declineEvidence = searchAnalytics[EXPLICIT_DECLINE_ARRAY_KEY];

  if (!Array.isArray(declineEvidence)) {
    return candidates;
  }

  declineEvidence.forEach((item, index) => {
    const rawUrl = extractPageUrl(item);

    if (!rawUrl) {
      return;
    }

    candidates.push({
      rawUrl,
      source: {
        type: "explicit_decline_evidence",
        path: `searchAnalytics.${EXPLICIT_DECLINE_ARRAY_KEY}[${index}]`,
      },
      evidence: summarizeSelectionEvidence(item),
    });
  });

  return candidates;
}

function extractPageUrl(value) {
  if (typeof value === "string") {
    return value;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  for (const key of ["inspectionUrl", "pageUrl", "url", "page"]) {
    if (typeof value[key] === "string" && value[key].trim()) {
      return value[key];
    }
  }

  if (typeof value.dimensions?.page === "string") {
    return value.dimensions.page;
  }

  return null;
}

function summarizeSelectionEvidence(value) {
  if (!value || typeof value !== "object") {
    return {
      dimensions: null,
      keys: null,
    };
  }

  return {
    dimensions: value.dimensions ?? null,
    keys: value.keys ?? null,
    comparison: value.comparison ?? value.currentVsPrevious ?? null,
  };
}

export function validateInspectionTargets({
  candidates,
  configuredMaximum,
  siteUrl,
}) {
  const selectedTargets = [];
  const rejectedTargets = [];
  const uniqueTargets = [];
  const seenInspectionUrls = new Set();

  for (const candidate of candidates) {
    const validation = normalizeInspectionUrl(candidate.rawUrl);

    if (!validation.ok) {
      rejectedTargets.push({
        rawUrl: candidate.rawUrl,
        reason: validation.reason,
        source: candidate.source,
      });
      continue;
    }

    if (!isInspectionUrlAllowedForProperty(validation.inspectionUrl, siteUrl)) {
      rejectedTargets.push({
        rawUrl: candidate.rawUrl,
        inspectionUrl: validation.inspectionUrl,
        reason: "outside_configured_property",
        source: candidate.source,
      });
      continue;
    }

    if (seenInspectionUrls.has(validation.inspectionUrl)) {
      rejectedTargets.push({
        rawUrl: candidate.rawUrl,
        inspectionUrl: validation.inspectionUrl,
        reason: "duplicate_url",
        source: candidate.source,
      });
      continue;
    }

    seenInspectionUrls.add(validation.inspectionUrl);
    uniqueTargets.push({
      inspectionUrl: validation.inspectionUrl,
      source: candidate.source,
      evidence: candidate.evidence,
    });
  }

  uniqueTargets.forEach((target, index) => {
    if (index < configuredMaximum) {
      selectedTargets.push(target);
      return;
    }

    rejectedTargets.push({
      rawUrl: target.inspectionUrl,
      inspectionUrl: target.inspectionUrl,
      reason: "exceeds_configured_maximum",
      source: target.source,
    });
  });

  rejectedTargets.sort(compareRejectedTargets);

  return {
    selectedTargets,
    rejectedTargets,
  };
}

function normalizeInspectionUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    return {
      ok: false,
      reason: "malformed_url",
    };
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(rawUrl.trim());
  } catch {
    return {
      ok: false,
      reason: "malformed_url",
    };
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return {
      ok: false,
      reason: "unsupported_url_protocol",
    };
  }

  if (parsedUrl.username || parsedUrl.password) {
    return {
      ok: false,
      reason: "url_contains_credentials",
    };
  }

  parsedUrl.hash = "";

  return {
    ok: true,
    inspectionUrl: parsedUrl.href,
  };
}

function isInspectionUrlAllowedForProperty(inspectionUrl, siteUrl) {
  const targetUrl = new URL(inspectionUrl);

  if (siteUrl.startsWith("sc-domain:")) {
    const domain = siteUrl.slice("sc-domain:".length).trim().toLowerCase();

    return (
      targetUrl.hostname.toLowerCase() === domain ||
      targetUrl.hostname.toLowerCase().endsWith(`.${domain}`)
    );
  }

  const propertyUrl = new URL(siteUrl);
  propertyUrl.hash = "";

  return targetUrl.href.startsWith(propertyUrl.href);
}

function compareRejectedTargets(a, b) {
  return (
    String(a.reason).localeCompare(String(b.reason)) ||
    String(a.inspectionUrl ?? a.rawUrl ?? "").localeCompare(
      String(b.inspectionUrl ?? b.rawUrl ?? ""),
    )
  );
}

async function inspectUrl({
  accessToken,
  fetchImpl,
  inspectionUrl,
  languageCode,
  siteUrl,
}) {
  const requestBody = {
    inspectionUrl,
    siteUrl,
  };

  if (languageCode?.trim()) {
    requestBody.languageCode = languageCode.trim();
  }

  let response;
  let body;

  try {
    response = await fetchImpl(URL_INSPECTION_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(30_000),
    });
    body = await readJsonResponse(response);
  } catch (error) {
    return {
      ok: false,
      status: null,
      error: error instanceof Error ? error.message : String(error),
      body: null,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: describeGoogleError(body) || `HTTP ${response.status}`,
      body,
    };
  }

  return {
    ok: true,
    status: response.status,
    error: null,
    body,
  };
}

async function fetchAccessToken() {
  const GoogleAuth = await loadGoogleAuth();
  const auth = new GoogleAuth({
    scopes: [SEARCH_CONSOLE_SCOPE],
  });

  let accessToken;

  try {
    accessToken = await auth.getAccessToken();
  } catch (error) {
    throw new CollectionError(
      [
        "Google Application Default Credentials could not provide a Search Console access token.",
        error instanceof Error ? error.message : String(error),
        "Confirm the GitHub Actions workflow authenticated with Workload Identity Federation and the service account has the Search Console readonly scope available.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  if (!accessToken) {
    throw new CollectionError(
      "Google Application Default Credentials did not return an access token.",
    );
  }

  return accessToken;
}

async function loadGoogleAuth() {
  try {
    const googleAuthLibrary = await import("google-auth-library");
    const GoogleAuth =
      googleAuthLibrary.GoogleAuth ?? googleAuthLibrary.default?.GoogleAuth;

    if (!GoogleAuth) {
      throw new Error("GoogleAuth export was not found.");
    }

    return GoogleAuth;
  } catch (error) {
    throw new CollectionError(
      [
        "The official google-auth-library package is not installed or could not be loaded.",
        "Run `npm ci` before collecting the audit bundle.",
        error instanceof Error ? error.message : String(error),
      ].join("\n"),
    );
  }
}

function buildSummaryCounts({
  selectedTargets,
  rejectedTargets,
  inspectedUrls,
  inspectionResults,
  requestErrors,
  warnings,
}) {
  return {
    selectedTargets: selectedTargets.length,
    rejectedTargets: rejectedTargets.length,
    inspectedUrls: inspectedUrls.length,
    successfulInspections: inspectionResults.length,
    requestErrors: requestErrors.length,
    warnings: warnings.length,
    byCoverageState: countInspectionResultField(
      inspectionResults,
      "coverageState",
    ),
    byRobotsTxtState: countInspectionResultField(
      inspectionResults,
      "robotsTxtState",
    ),
    byIndexingState: countInspectionResultField(
      inspectionResults,
      "indexingState",
    ),
    byPageFetchState: countInspectionResultField(
      inspectionResults,
      "pageFetchState",
    ),
  };
}

function countInspectionResultField(inspectionResults, field) {
  const counts = {};

  for (const result of inspectionResults) {
    const value = result.response?.inspectionResult?.indexStatusResult?.[field];

    if (value === undefined || value === null || value === "") {
      continue;
    }

    counts[value] = (counts[value] ?? 0) + 1;
  }

  return Object.fromEntries(
    Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)),
  );
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

function describeGoogleError(body) {
  if (body?.error?.message) {
    return body.error.message;
  }

  if (typeof body?.error === "string") {
    return [body.error, body.error_description].filter(Boolean).join(": ");
  }

  if (body?.raw) {
    return body.raw;
  }

  return "";
}

async function upsertAuditBundle(outputDir, searchConsoleUrlInspection) {
  const auditBundlePath = path.join(outputDir, "audit-bundle.json");
  const auditBundle = await readExistingAuditBundle(auditBundlePath);

  await writeJson(auditBundlePath, {
    ...auditBundle,
    searchConsoleUrlInspection,
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

export function normalizeSiteUrl(rawSiteUrl) {
  const siteUrl = String(rawSiteUrl).trim();

  if (siteUrl.startsWith("sc-domain:")) {
    const domain = siteUrl.slice("sc-domain:".length).trim();

    if (!domain || /[/?#\s]/.test(domain)) {
      throw new CollectionError(
        "GOOGLE_SEARCH_CONSOLE_SITE_URL must contain a valid sc-domain property.",
      );
    }

    return `sc-domain:${domain.toLowerCase()}`;
  }

  if (!siteUrl.startsWith("http://") && !siteUrl.startsWith("https://")) {
    throw new CollectionError(
      [
        "GOOGLE_SEARCH_CONSOLE_SITE_URL must be a Search Console property URL.",
        "Use a URL-prefix property such as https://example.com/ or a domain property such as sc-domain:example.com.",
      ].join("\n"),
    );
  }

  let propertyUrl;

  try {
    propertyUrl = new URL(siteUrl);
  } catch {
    throw new CollectionError(
      "GOOGLE_SEARCH_CONSOLE_SITE_URL must be a valid absolute HTTP or HTTPS URL.",
    );
  }

  if (propertyUrl.username || propertyUrl.password) {
    throw new CollectionError(
      "GOOGLE_SEARCH_CONSOLE_SITE_URL must not include credentials.",
    );
  }

  propertyUrl.hash = "";

  return propertyUrl.href;
}

const isCli = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isCli) {
  main().catch((error) => {
    if (error instanceof CollectionError) {
      console.error(error.message);
    } else {
      console.error("Unexpected Search Console URL Inspection collection failure.");
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exit(1);
  });
}
