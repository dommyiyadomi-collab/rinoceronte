#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const REQUIRED_ENV_VARS = ["GOOGLE_SEARCH_CONSOLE_SITE_URL"];
const SEARCH_CONSOLE_SCOPE =
  "https://www.googleapis.com/auth/webmasters.readonly";
const SEARCH_ANALYTICS_ROW_LIMIT = 25_000;
const SEARCH_ANALYTICS_REPORTS = [
  { name: "summary", dimensions: [] },
  { name: "byDate", dimensions: ["date"] },
  { name: "topQueries", dimensions: ["query"] },
  { name: "topPages", dimensions: ["page"] },
  { name: "topPageQueries", dimensions: ["page", "query"] },
  { name: "byCountry", dimensions: ["country"] },
  { name: "byDevice", dimensions: ["device"] },
];

class CollectionError extends Error {}

async function main() {
  const outputDir = process.argv[2];

  if (!outputDir) {
    throw new CollectionError(
      "Missing output directory argument. Usage: node scripts/collect-search-console-search-analytics.mjs out/audit-bundle",
    );
  }

  const env = readEnvironment();
  const siteUrl = normalizeSiteUrl(env.GOOGLE_SEARCH_CONSOLE_SITE_URL);
  const dateRange = defaultDateRange();
  const accessToken = await fetchAccessToken();
  const searchAnalytics = await collectSearchAnalytics({
    accessToken,
    dateRange,
    siteUrl,
  });
  const generatedAt = new Date().toISOString();
  const searchConsoleData = {
    generatedAt,
    source: {
      product: "Google Search Console",
      api: "searchanalytics.query",
      scope: SEARCH_CONSOLE_SCOPE,
      siteUrl,
    },
    searchAnalytics,
  };
  const auditBundle = {
    searchConsole: searchConsoleData,
  };

  await mkdir(outputDir, { recursive: true });
  await writeJson(
    path.join(outputDir, "search-console-search-analytics.json"),
    searchConsoleData,
  );
  await writeJson(path.join(outputDir, "audit-bundle.json"), auditBundle);

  console.log(
    `Collected Search Console Search Analytics data for ${siteUrl} from ${dateRange.startDate} to ${dateRange.endDate}.`,
  );
}

function readEnvironment() {
  const missingEnvVars = REQUIRED_ENV_VARS.filter(
    (envVar) => !process.env[envVar]?.trim(),
  );

  if (missingEnvVars.length > 0) {
    throw new CollectionError(
      [
        "Google Search Console Search Analytics collection is not configured.",
        "Missing required environment variable(s):",
        ...missingEnvVars.map((envVar) => `  - ${envVar}`),
        "",
        "Set the missing values before collecting the audit bundle.",
        "See docs/search-console-auth.md for the required configuration.",
      ].join("\n"),
    );
  }

  return {
    GOOGLE_SEARCH_CONSOLE_SITE_URL:
      process.env.GOOGLE_SEARCH_CONSOLE_SITE_URL,
  };
}

function normalizeSiteUrl(rawSiteUrl) {
  const siteUrl = rawSiteUrl.trim();

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

function defaultDateRange() {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 3);

  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 27);

  return {
    startDate: formatDate(start),
    endDate: formatDate(end),
  };
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
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

async function collectSearchAnalytics({ accessToken, dateRange, siteUrl }) {
  const reports = [];

  for (const report of SEARCH_ANALYTICS_REPORTS) {
    const request = {
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
      dimensions: report.dimensions,
      type: "web",
      rowLimit: SEARCH_ANALYTICS_ROW_LIMIT,
    };
    const response = await querySearchAnalytics({
      accessToken,
      request,
      siteUrl,
    });

    reports.push({
      name: report.name,
      request,
      response: normalizeSearchAnalyticsResponse(response, report.dimensions),
    });
  }

  return {
    dateRange,
    reports,
  };
}

async function querySearchAnalytics({ accessToken, request, siteUrl }) {
  const endpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await readJsonResponse(response);

  if (!response.ok) {
    throw new CollectionError(
      [
        `Search Console Search Analytics API request failed (HTTP ${response.status}).`,
        describeGoogleError(body),
        "Confirm the Search Console API is enabled and the service account has access to GOOGLE_SEARCH_CONSOLE_SITE_URL.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return body;
}

function normalizeSearchAnalyticsResponse(response, dimensions) {
  return {
    responseAggregationType: response.responseAggregationType ?? null,
    metadata: response.metadata ?? null,
    rows: (response.rows ?? []).map((row) => ({
      dimensions: Object.fromEntries(
        dimensions.map((dimension, index) => [
          dimension,
          row.keys?.[index] ?? null,
        ]),
      ),
      keys: row.keys ?? [],
      clicks: row.clicks ?? 0,
      impressions: row.impressions ?? 0,
      ctr: row.ctr ?? 0,
      position: row.position ?? null,
    })),
  };
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

async function writeJson(filePath, data) {
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

main().catch((error) => {
  if (error instanceof CollectionError) {
    console.error(error.message);
  } else {
    console.error("Unexpected Search Console collection failure.");
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exit(1);
});
