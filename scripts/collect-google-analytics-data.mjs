#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const REQUIRED_ENV_VARS = [
  "GOOGLE_ANALYTICS_CREDENTIALS_JSON",
  "GOOGLE_ANALYTICS_PROPERTY_ID",
];
const REQUIRED_CREDENTIAL_FIELDS = ["type", "client_email", "private_key"];
const GA_REPORTS = [
  {
    name: "summary",
    dimensions: [],
    metrics: [
      "activeUsers",
      "sessions",
      "screenPageViews",
      "engagedSessions",
      "engagementRate",
      "averageSessionDuration",
    ],
  },
  {
    name: "byDate",
    dimensions: ["date"],
    metrics: [
      "activeUsers",
      "sessions",
      "screenPageViews",
      "engagedSessions",
      "engagementRate",
      "averageSessionDuration",
    ],
    limit: 100,
    orderBys: [{ dimension: { dimensionName: "date" } }],
  },
  {
    name: "topPages",
    dimensions: ["pagePathPlusQueryString", "pageTitle"],
    metrics: [
      "screenPageViews",
      "activeUsers",
      "sessions",
      "engagementRate",
      "averageSessionDuration",
    ],
    limit: 50,
    orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
  },
  {
    name: "byChannel",
    dimensions: ["sessionDefaultChannelGroup"],
    metrics: ["activeUsers", "sessions", "screenPageViews", "engagementRate"],
    limit: 25,
    orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
  },
  {
    name: "byCountry",
    dimensions: ["country"],
    metrics: ["activeUsers", "sessions", "screenPageViews", "engagementRate"],
    limit: 25,
    orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
  },
  {
    name: "byDevice",
    dimensions: ["deviceCategory"],
    metrics: ["activeUsers", "sessions", "screenPageViews", "engagementRate"],
    limit: 25,
    orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
  },
];

class CollectionError extends Error {}

async function main() {
  const outputDir = process.argv[2];

  if (!outputDir) {
    throw new CollectionError(
      "Missing output directory argument. Usage: node scripts/collect-google-analytics-data.mjs out/audit-bundle",
    );
  }

  const env = readEnvironment();
  const credentials = parseServiceAccountCredentials(
    env.GOOGLE_ANALYTICS_CREDENTIALS_JSON,
  );
  const propertyId = normalizePropertyId(env.GOOGLE_ANALYTICS_PROPERTY_ID);
  const BetaAnalyticsDataClient = await loadAnalyticsDataClient();
  const client = new BetaAnalyticsDataClient({
    credentials: {
      client_email: credentials.client_email,
      private_key: credentials.private_key,
    },
    projectId: credentials.project_id,
  });
  const dateRange = defaultDateRange();
  const analyticsData = await collectGoogleAnalyticsReports({
    client,
    dateRange,
    propertyId,
  });
  const generatedAt = new Date().toISOString();
  const googleAnalyticsData = {
    generatedAt,
    source: {
      product: "Google Analytics 4",
      api: "properties.runReport",
      client: "@google-analytics/data",
      property: `properties/${propertyId}`,
    },
    analyticsData,
  };

  await mkdir(outputDir, { recursive: true });
  await writeJson(
    path.join(outputDir, "google-analytics-data.json"),
    googleAnalyticsData,
  );
  await upsertAuditBundle(outputDir, googleAnalyticsData);

  console.log(
    `Collected Google Analytics Data API reports for properties/${propertyId} from ${dateRange.startDate} to ${dateRange.endDate}.`,
  );
}

function readEnvironment() {
  const missingEnvVars = REQUIRED_ENV_VARS.filter(
    (envVar) => !process.env[envVar]?.trim(),
  );

  if (missingEnvVars.length > 0) {
    throw new CollectionError(
      [
        "Google Analytics Data API collection is not configured.",
        "Missing required environment variable(s):",
        ...missingEnvVars.map((envVar) => `  - ${envVar}`),
        "",
        "Add the missing values as GitHub Secrets before collecting the audit bundle.",
        "See docs/google-analytics-auth.md for the required secret names.",
      ].join("\n"),
    );
  }

  return {
    GOOGLE_ANALYTICS_CREDENTIALS_JSON:
      process.env.GOOGLE_ANALYTICS_CREDENTIALS_JSON,
    GOOGLE_ANALYTICS_PROPERTY_ID: process.env.GOOGLE_ANALYTICS_PROPERTY_ID,
  };
}

function parseServiceAccountCredentials(rawCredentials) {
  let credentials;

  try {
    credentials = JSON.parse(rawCredentials);
  } catch {
    throw new CollectionError(
      "GOOGLE_ANALYTICS_CREDENTIALS_JSON must be valid JSON.",
    );
  }

  const missingFields = REQUIRED_CREDENTIAL_FIELDS.filter(
    (field) => !credentials[field],
  );

  if (missingFields.length > 0) {
    throw new CollectionError(
      `GOOGLE_ANALYTICS_CREDENTIALS_JSON is missing required service account field(s): ${missingFields.join(", ")}.`,
    );
  }

  if (credentials.type !== "service_account") {
    throw new CollectionError(
      "GOOGLE_ANALYTICS_CREDENTIALS_JSON must contain a service_account credential.",
    );
  }

  return credentials;
}

function normalizePropertyId(rawPropertyId) {
  let propertyId = rawPropertyId.trim();

  if (propertyId.startsWith("properties/")) {
    propertyId = propertyId.slice("properties/".length);
  }

  if (!/^\d+$/.test(propertyId)) {
    throw new CollectionError(
      "GOOGLE_ANALYTICS_PROPERTY_ID must be a numeric GA4 property ID, such as 123456789.",
    );
  }

  return propertyId;
}

async function loadAnalyticsDataClient() {
  try {
    const analyticsData = await import("@google-analytics/data");
    const BetaAnalyticsDataClient =
      analyticsData.BetaAnalyticsDataClient ??
      analyticsData.default?.BetaAnalyticsDataClient;

    if (!BetaAnalyticsDataClient) {
      throw new Error("BetaAnalyticsDataClient export was not found.");
    }

    return BetaAnalyticsDataClient;
  } catch (error) {
    throw new CollectionError(
      [
        "The official Google Analytics Data API client is not installed or could not be loaded.",
        "Run `npm ci` before collecting the audit bundle.",
        error instanceof Error ? error.message : String(error),
      ].join("\n"),
    );
  }
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

async function collectGoogleAnalyticsReports({ client, dateRange, propertyId }) {
  const reports = [];

  for (const report of GA_REPORTS) {
    const request = {
      property: `properties/${propertyId}`,
      dateRanges: [dateRange],
      dimensions: report.dimensions.map((name) => ({ name })),
      metrics: report.metrics.map((name) => ({ name })),
      keepEmptyRows: false,
    };

    if (report.limit) {
      request.limit = report.limit;
    }

    if (report.orderBys) {
      request.orderBys = report.orderBys;
    }

    const response = await runReport({ client, request, propertyId });

    reports.push({
      name: report.name,
      request: {
        dateRange,
        dimensions: report.dimensions,
        metrics: report.metrics,
        limit: report.limit ?? null,
        orderBys: report.orderBys ?? [],
      },
      response: normalizeRunReportResponse(response, report),
    });
  }

  return {
    dateRange,
    reports,
  };
}

async function runReport({ client, request, propertyId }) {
  try {
    const [response] = await client.runReport(request);

    return response;
  } catch (error) {
    throw new CollectionError(
      [
        "Google Analytics Data API request failed.",
        error instanceof Error ? error.message : String(error),
        `Confirm the Google Analytics Data API is enabled and the service account has Viewer access to properties/${propertyId}.`,
      ].join("\n"),
    );
  }
}

function normalizeRunReportResponse(response, report) {
  return {
    rowCount: response.rowCount ?? 0,
    rows: (response.rows ?? []).map((row) => ({
      dimensions: Object.fromEntries(
        report.dimensions.map((dimension, index) => [
          dimension,
          row.dimensionValues?.[index]?.value ?? null,
        ]),
      ),
      metrics: Object.fromEntries(
        report.metrics.map((metric, index) => [
          metric,
          parseMetricValue(row.metricValues?.[index]?.value),
        ]),
      ),
    })),
    totals: normalizeMetricRows(response.totals, report.metrics),
    maximums: normalizeMetricRows(response.maximums, report.metrics),
    minimums: normalizeMetricRows(response.minimums, report.metrics),
  };
}

function normalizeMetricRows(rows = [], metrics) {
  return rows.map((row) =>
    Object.fromEntries(
      metrics.map((metric, index) => [
        metric,
        parseMetricValue(row.metricValues?.[index]?.value),
      ]),
    ),
  );
}

function parseMetricValue(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const numericValue = Number(value);

  return Number.isFinite(numericValue) ? numericValue : value;
}

async function upsertAuditBundle(outputDir, googleAnalyticsData) {
  const auditBundlePath = path.join(outputDir, "audit-bundle.json");
  const auditBundle = await readExistingAuditBundle(auditBundlePath);

  await writeJson(auditBundlePath, {
    ...auditBundle,
    googleAnalytics: googleAnalyticsData,
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

main().catch((error) => {
  if (error instanceof CollectionError) {
    console.error(error.message);
  } else {
    console.error("Unexpected Google Analytics Data API collection failure.");
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exit(1);
});
