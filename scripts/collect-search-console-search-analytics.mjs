#!/usr/bin/env node
import { createSign } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const REQUIRED_ENV_VARS = [
  "GOOGLE_SEARCH_CONSOLE_CREDENTIALS_JSON",
  "GOOGLE_SEARCH_CONSOLE_SITE_URL",
];
const REQUIRED_CREDENTIAL_FIELDS = ["type", "client_email", "private_key"];
const SEARCH_CONSOLE_SCOPE =
  "https://www.googleapis.com/auth/webmasters.readonly";
const TOKEN_URI = "https://oauth2.googleapis.com/token";
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
  const credentials = parseServiceAccountCredentials(
    env.GOOGLE_SEARCH_CONSOLE_CREDENTIALS_JSON,
  );
  const siteUrl = normalizeSiteUrl(env.GOOGLE_SEARCH_CONSOLE_SITE_URL);
  const dateRange = defaultDateRange();
  const accessToken = await fetchAccessToken(credentials);
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
        "Add the missing values as GitHub Secrets before collecting the audit bundle.",
        "See docs/search-console-auth.md for the required secret names.",
      ].join("\n"),
    );
  }

  return {
    GOOGLE_SEARCH_CONSOLE_CREDENTIALS_JSON:
      process.env.GOOGLE_SEARCH_CONSOLE_CREDENTIALS_JSON,
    GOOGLE_SEARCH_CONSOLE_SITE_URL:
      process.env.GOOGLE_SEARCH_CONSOLE_SITE_URL,
  };
}

function parseServiceAccountCredentials(rawCredentials) {
  let credentials;

  try {
    credentials = JSON.parse(rawCredentials);
  } catch {
    throw new CollectionError(
      "GOOGLE_SEARCH_CONSOLE_CREDENTIALS_JSON must be valid JSON.",
    );
  }

  const missingFields = REQUIRED_CREDENTIAL_FIELDS.filter(
    (field) => !credentials[field],
  );

  if (missingFields.length > 0) {
    throw new CollectionError(
      `GOOGLE_SEARCH_CONSOLE_CREDENTIALS_JSON is missing required service account field(s): ${missingFields.join(", ")}.`,
    );
  }

  if (credentials.type !== "service_account") {
    throw new CollectionError(
      "GOOGLE_SEARCH_CONSOLE_CREDENTIALS_JSON must contain a service_account credential.",
    );
  }

  return credentials;
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

async function fetchAccessToken(credentials) {
  const tokenUri = credentials.token_uri || TOKEN_URI;
  const assertion = createServiceAccountJwt(credentials, tokenUri);
  const response = await fetch(tokenUri, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await readJsonResponse(response);

  if (!response.ok) {
    throw new CollectionError(
      [
        `Google OAuth access token request failed (HTTP ${response.status}).`,
        describeGoogleError(body),
        "Confirm GOOGLE_SEARCH_CONSOLE_CREDENTIALS_JSON contains a valid service account key with the Search Console readonly scope available.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  if (!body.access_token) {
    throw new CollectionError(
      "Google OAuth access token response did not include access_token.",
    );
  }

  return body.access_token;
}

function createServiceAccountJwt(credentials, tokenUri) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = {
    alg: "RS256",
    typ: "JWT",
  };

  if (credentials.private_key_id) {
    header.kid = credentials.private_key_id;
  }

  const claimSet = {
    iss: credentials.client_email,
    scope: SEARCH_CONSOLE_SCOPE,
    aud: tokenUri,
    exp: issuedAt + 3600,
    iat: issuedAt,
  };
  const unsignedJwt = `${base64urlJson(header)}.${base64urlJson(claimSet)}`;

  try {
    const signature = createSign("RSA-SHA256")
      .update(unsignedJwt)
      .sign(credentials.private_key);

    return `${unsignedJwt}.${base64url(signature)}`;
  } catch {
    throw new CollectionError(
      "GOOGLE_SEARCH_CONSOLE_CREDENTIALS_JSON private_key could not sign the OAuth JWT. Confirm the full service account private_key is present.",
    );
  }
}

function base64urlJson(value) {
  return base64url(Buffer.from(JSON.stringify(value), "utf8"));
}

function base64url(buffer) {
  return buffer
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
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
