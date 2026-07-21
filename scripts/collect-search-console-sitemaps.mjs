#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_ENV_VARS = ["GOOGLE_SEARCH_CONSOLE_SITE_URL"];
const COLLECTOR_VERSION = "1.0.0";
const SEARCH_CONSOLE_SCOPE =
  "https://www.googleapis.com/auth/webmasters.readonly";
const SEARCH_CONSOLE_SITEMAPS_API_VERSION = "webmasters/v3";
const SITEMAPS_LIST_ENDPOINT =
  "https://www.googleapis.com/webmasters/v3/sites/{siteUrl}/sitemaps";

class CollectionError extends Error {}

export async function main({
  argv = process.argv,
  env = process.env,
  fetchImpl = fetch,
  now = () => new Date(),
} = {}) {
  const outputDir = argv[2];

  if (!outputDir) {
    throw new CollectionError(
      "Missing output directory argument. Usage: node scripts/collect-search-console-sitemaps.mjs out/audit-bundle",
    );
  }

  const environment = readEnvironment(env);
  const siteUrl = normalizeSiteUrl(environment.GOOGLE_SEARCH_CONSOLE_SITE_URL);
  const accessToken = await fetchAccessToken();
  const searchConsoleSitemaps = await collectSearchConsoleSitemaps({
    accessToken,
    fetchImpl,
    now,
    siteUrl,
  });

  await mkdir(outputDir, { recursive: true });
  await writeJson(
    path.join(outputDir, "search-console-sitemaps.json"),
    searchConsoleSitemaps,
  );
  await upsertAuditBundle(outputDir, searchConsoleSitemaps);

  console.log(
    `Collected ${searchConsoleSitemaps.summaryCounts.totalSitemaps} Search Console sitemap record(s) for ${siteUrl}.`,
  );
}

function readEnvironment(env) {
  const missingEnvVars = REQUIRED_ENV_VARS.filter(
    (envVar) => !env[envVar]?.trim(),
  );

  if (missingEnvVars.length > 0) {
    throw new CollectionError(
      [
        "Google Search Console Sitemaps collection is not configured.",
        "Missing required environment variable(s):",
        ...missingEnvVars.map((envVar) => `  - ${envVar}`),
        "",
        "Set the missing values before collecting the audit bundle.",
        "See docs/search-console-sitemaps.md for the required configuration.",
      ].join("\n"),
    );
  }

  return {
    GOOGLE_SEARCH_CONSOLE_SITE_URL: env.GOOGLE_SEARCH_CONSOLE_SITE_URL,
  };
}

export function normalizeSiteUrl(rawSiteUrl) {
  const siteUrl = String(rawSiteUrl).trim();

  if (
    !siteUrl.startsWith("sc-domain:") &&
    !siteUrl.startsWith("http://") &&
    !siteUrl.startsWith("https://")
  ) {
    throw new CollectionError(
      [
        "GOOGLE_SEARCH_CONSOLE_SITE_URL must be a Search Console property URL.",
        "Use a URL-prefix property such as https://example.com/ or a domain property such as sc-domain:example.com.",
      ].join("\n"),
    );
  }

  return siteUrl;
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

export async function collectSearchConsoleSitemaps({
  accessToken,
  fetchImpl = fetch,
  now = () => new Date(),
  siteUrl,
}) {
  const generatedAt = now().toISOString();
  const requests = [];
  const sitemapsByPath = new Map();
  const sitemapIndexQueue = [null];
  const fetchedSitemapIndexes = new Set();
  const warnings = [];
  const errors = [];

  while (sitemapIndexQueue.length > 0) {
    const sitemapIndex = sitemapIndexQueue.shift();
    const sitemapIndexKey = sitemapIndex ?? "";

    if (fetchedSitemapIndexes.has(sitemapIndexKey)) {
      continue;
    }

    fetchedSitemapIndexes.add(sitemapIndexKey);

    const response = await listSitemaps({
      accessToken,
      fetchImpl,
      sitemapIndex,
      siteUrl,
    });
    const sitemaps = Array.isArray(response.sitemap) ? response.sitemap : [];
    requests.push({
      sitemapIndex,
      sitemapCount: sitemaps.length,
    });

    if (response.sitemap !== undefined && !Array.isArray(response.sitemap)) {
      warnings.push(
        `Ignored non-array sitemap response for sitemapIndex ${sitemapIndex ?? "(root)"}.`,
      );
    }

    for (const sitemap of sitemaps) {
      const normalized = normalizeSitemapRecord(sitemap, sitemapIndex);

      if (!normalized.path) {
        warnings.push(
          `Ignored Search Console sitemap entry without a path for sitemapIndex ${sitemapIndex ?? "(root)"}.`,
        );
        continue;
      }

      const existing = sitemapsByPath.get(normalized.path);

      if (existing) {
        existing.sources.push(...normalized.sources);
      } else {
        sitemapsByPath.set(normalized.path, normalized);
      }

      if (
        normalized.isSitemapsIndex === true &&
        !fetchedSitemapIndexes.has(normalized.path)
      ) {
        sitemapIndexQueue.push(normalized.path);
      }
    }
  }

  const sitemaps = [...sitemapsByPath.values()]
    .map((sitemap) => ({
      ...sitemap,
      sources: dedupeSources(sitemap.sources),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  return {
    generatedAt,
    property: siteUrl,
    collectorVersion: COLLECTOR_VERSION,
    apiVersion: SEARCH_CONSOLE_SITEMAPS_API_VERSION,
    source: {
      product: "Google Search Console",
      api: "sitemaps.list",
      method: "GET",
      endpoint: SITEMAPS_LIST_ENDPOINT,
      scope: SEARCH_CONSOLE_SCOPE,
      property: siteUrl,
    },
    requests,
    sitemaps,
    summaryCounts: buildSummaryCounts(sitemaps),
    errors,
    warnings,
  };
}

async function listSitemaps({
  accessToken,
  fetchImpl,
  sitemapIndex,
  siteUrl,
}) {
  const endpoint = new URL(
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps`,
  );

  if (sitemapIndex) {
    endpoint.searchParams.set("sitemapIndex", sitemapIndex);
  }

  const response = await fetchImpl(endpoint.href, {
    method: "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
    },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await readJsonResponse(response);

  if (!response.ok) {
    throw new CollectionError(
      [
        `Search Console Sitemaps API request failed (HTTP ${response.status}).`,
        describeGoogleError(body),
        "Confirm the Search Console API is enabled and the service account has access to GOOGLE_SEARCH_CONSOLE_SITE_URL.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return body;
}

function normalizeSitemapRecord(sitemap, sitemapIndex) {
  return {
    path: typeof sitemap.path === "string" ? sitemap.path : null,
    lastSubmitted: sitemap.lastSubmitted ?? null,
    lastDownloaded: sitemap.lastDownloaded ?? null,
    isPending: sitemap.isPending ?? null,
    isSitemapsIndex: sitemap.isSitemapsIndex ?? null,
    type: sitemap.type ?? null,
    warnings: sitemap.warnings ?? null,
    errors: sitemap.errors ?? null,
    contents: normalizeSitemapContents(sitemap.contents),
    sources: [
      {
        sitemapIndex,
      },
    ],
  };
}

function normalizeSitemapContents(contents) {
  if (!Array.isArray(contents)) {
    return [];
  }

  return contents.map((content) => ({
    type: content.type ?? null,
    submitted: content.submitted ?? null,
  }));
}

function dedupeSources(sources) {
  const seen = new Set();
  const deduped = [];

  for (const source of sources) {
    const key = source.sitemapIndex ?? "";

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(source);
  }

  return deduped.sort((a, b) =>
    String(a.sitemapIndex ?? "").localeCompare(String(b.sitemapIndex ?? "")),
  );
}

function buildSummaryCounts(sitemaps) {
  const bySitemapType = {};
  const byContentType = {};
  let submittedUrls = 0;

  for (const sitemap of sitemaps) {
    incrementCount(bySitemapType, sitemap.type);

    for (const content of sitemap.contents) {
      incrementCount(byContentType, content.type);

      if (Number.isFinite(Number(content.submitted))) {
        submittedUrls += Number(content.submitted);
      }
    }
  }

  return {
    totalSitemaps: sitemaps.length,
    sitemapIndexes: sitemaps.filter((sitemap) => sitemap.isSitemapsIndex === true)
      .length,
    pending: sitemaps.filter((sitemap) => sitemap.isPending === true).length,
    withWarnings: sitemaps.filter((sitemap) => Number(sitemap.warnings) > 0)
      .length,
    withErrors: sitemaps.filter((sitemap) => Number(sitemap.errors) > 0).length,
    warnings: sumNumericField(sitemaps, "warnings"),
    errors: sumNumericField(sitemaps, "errors"),
    submittedUrls,
    bySitemapType,
    byContentType,
  };
}

function incrementCount(counts, key) {
  const normalizedKey = key ?? "unknown";
  counts[normalizedKey] = (counts[normalizedKey] ?? 0) + 1;
}

function sumNumericField(records, field) {
  return records.reduce((total, record) => {
    const value = Number(record[field]);
    return Number.isFinite(value) ? total + value : total;
  }, 0);
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
  if (body.error?.message) {
    return body.error.message;
  }

  if (typeof body.error === "string") {
    return [body.error, body.error_description].filter(Boolean).join(": ");
  }

  if (body.raw) {
    return body.raw;
  }

  return "";
}

async function upsertAuditBundle(outputDir, searchConsoleSitemaps) {
  const auditBundlePath = path.join(outputDir, "audit-bundle.json");
  const auditBundle = await readExistingAuditBundle(auditBundlePath);

  await writeJson(auditBundlePath, {
    ...auditBundle,
    searchConsoleSitemaps,
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
      console.error("Unexpected Search Console Sitemaps collection failure.");
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exit(1);
  });
}
