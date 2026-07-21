import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectAndWriteSearchConsoleUrlInspection,
  selectDecliningPageTargets,
} from "./collect-search-console-url-inspection.mjs";

const URL_INSPECTION_ENDPOINT =
  "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";

test("selects declining page targets only from explicit decline evidence", () => {
  const candidates = selectDecliningPageTargets({
    declineEvidence: [
      {
        dimensions: {
          page: "https://example.com/declined.html",
        },
        comparison: {
          currentPeriod: "2026-07-01/2026-07-14",
          previousPeriod: "2026-06-17/2026-06-30",
        },
      },
      {
        dimensions: {
          query: "digital nomad japan",
        },
      },
    ],
    reports: [
      {
        name: "topPages",
        request: {
          dimensions: ["page"],
        },
        response: {
          rows: [
            {
              keys: ["https://example.com/current-only.html"],
              dimensions: {
                page: "https://example.com/current-only.html",
              },
              declined: true,
            },
          ],
        },
      },
    ],
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].rawUrl, "https://example.com/declined.html");
  assert.equal(candidates[0].source.path, "searchAnalytics.declineEvidence[0]");
});

test("insufficient evidence skips and never falls back to sitemap URLs", async () => {
  const outputDir = await createAuditBundle({
    searchConsole: {
      searchAnalytics: {
        reports: [
          {
            name: "topPages",
            request: {
              dimensions: ["page"],
            },
            response: {
              rows: [
                {
                  keys: ["https://example.com/current-only.html"],
                  dimensions: {
                    page: "https://example.com/current-only.html",
                  },
                  clicks: 5,
                  impressions: 50,
                },
              ],
            },
          },
        ],
      },
    },
    siteInventory: {
      urlInventory: [
        {
          url: "https://example.com/sitemap-page.html",
        },
      ],
    },
  });
  let tokenRequested = false;
  let fetchRequested = false;

  try {
    const result = await collectAndWriteSearchConsoleUrlInspection({
      outputDir,
      siteUrl: "https://example.com/",
      configuredMaximumRaw: "5",
      fetchAccessTokenImpl: async () => {
        tokenRequested = true;
        return "token";
      },
      fetchImpl: async () => {
        fetchRequested = true;
        throw new Error("URL Inspection should not be requested.");
      },
      now: () => new Date("2026-07-21T00:00:00.000Z"),
    });

    assert.equal(result.targetSelectionStatus.status, "skipped");
    assert.equal(
      result.targetSelectionStatus.reason,
      "insufficient_search_analytics_decline_evidence",
    );
    assert.deepEqual(result.selectedTargets, []);
    assert.deepEqual(result.inspectedUrls, []);
    assert.equal(tokenRequested, false);
    assert.equal(fetchRequested, false);

    const auditBundle = await readAuditBundle(outputDir);
    assert.equal(
      auditBundle.searchConsoleUrlInspection.targetSelectionStatus.reason,
      "insufficient_search_analytics_decline_evidence",
    );
    assert.equal(
      auditBundle.searchConsoleUrlInspection.selectedTargets.some(
        (target) => target.inspectionUrl === "https://example.com/sitemap-page.html",
      ),
      false,
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("rejects malformed, unrelated, and duplicate URLs before inspection", async () => {
  const outputDir = await createAuditBundle({
    searchConsole: {
      searchAnalytics: {
        declineEvidence: [
          {
            page: "https://example.com/declined.html",
          },
          {
            page: "https://example.com/declined.html#section",
          },
          {
            page: "not a url",
          },
          {
            page: "https://unrelated.example/declined.html",
          },
        ],
      },
    },
  });
  const requests = [];

  try {
    const result = await collectAndWriteSearchConsoleUrlInspection({
      outputDir,
      siteUrl: "https://example.com/",
      configuredMaximumRaw: "10",
      fetchAccessTokenImpl: async () => "token",
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return jsonResponse({
          inspectionResult: {
            indexStatusResult: {
              coverageState: "Submitted and indexed",
            },
          },
        });
      },
      now: () => new Date("2026-07-21T00:00:00.000Z"),
    });

    assert.equal(result.selectedTargets.length, 1);
    assert.deepEqual(
      result.rejectedTargets.map((target) => target.reason).sort(),
      ["duplicate_url", "malformed_url", "outside_configured_property"],
    );
    assert.equal(requests.length, 1);
    assert.equal(
      JSON.parse(requests[0].options.body).inspectionUrl,
      "https://example.com/declined.html",
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("configured maximum is respected and missing maximum skips safely", async () => {
  const maxOutputDir = await createAuditBundle({
    searchConsole: {
      searchAnalytics: {
        declineEvidence: [
          "https://example.com/one.html",
          "https://example.com/two.html",
          "https://example.com/three.html",
        ],
      },
    },
  });
  const requests = [];

  try {
    const result = await collectAndWriteSearchConsoleUrlInspection({
      outputDir: maxOutputDir,
      siteUrl: "https://example.com/",
      configuredMaximumRaw: "2",
      fetchAccessTokenImpl: async () => "token",
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return jsonResponse({
          inspectionResult: {
            indexStatusResult: {
              coverageState: "Indexed",
            },
          },
        });
      },
      now: () => new Date("2026-07-21T00:00:00.000Z"),
    });

    assert.equal(result.selectedTargets.length, 2);
    assert.equal(result.inspectedUrls.length, 2);
    assert.equal(requests.length, 2);
    assert.equal(result.rejectedTargets.length, 1);
    assert.equal(result.rejectedTargets[0].reason, "exceeds_configured_maximum");
  } finally {
    await rm(maxOutputDir, { recursive: true, force: true });
  }

  const missingMaxOutputDir = await createAuditBundle({
    searchConsole: {
      searchAnalytics: {
        declineEvidence: ["https://example.com/one.html"],
      },
    },
  });
  let tokenRequested = false;

  try {
    const result = await collectAndWriteSearchConsoleUrlInspection({
      outputDir: missingMaxOutputDir,
      siteUrl: "https://example.com/",
      configuredMaximumRaw: "",
      fetchAccessTokenImpl: async () => {
        tokenRequested = true;
        return "token";
      },
      fetchImpl: async () => {
        throw new Error("URL Inspection should not be requested.");
      },
      now: () => new Date("2026-07-21T00:00:00.000Z"),
    });

    assert.equal(result.targetSelectionStatus.status, "skipped");
    assert.equal(
      result.targetSelectionStatus.reason,
      "missing_configured_maximum",
    );
    assert.equal(tokenRequested, false);
  } finally {
    await rm(missingMaxOutputDir, { recursive: true, force: true });
  }
});

test("preserves successful responses, isolates URL failures, and uses only URL Inspection", async () => {
  const outputDir = await createAuditBundle({
    searchConsole: {
      preserved: true,
      searchAnalytics: {
        declineEvidence: [
          {
            pageUrl: "https://example.com/success.html",
          },
          {
            pageUrl: "https://example.com/failure.html",
          },
        ],
      },
    },
  });
  const requests = [];
  const successBody = {
    inspectionResult: {
      inspectionResultLink: "https://search.google.com/search-console/inspect",
      indexStatusResult: {
        verdict: "PASS",
        coverageState: "Submitted and indexed",
        robotsTxtState: "ALLOWED",
        indexingState: "INDEXING_ALLOWED",
        lastCrawlTime: "2026-07-20T00:00:00Z",
        pageFetchState: "SUCCESSFUL",
        googleCanonical: "https://example.com/success.html",
        userCanonical: "https://example.com/success.html",
        crawledAs: "MOBILE",
        referringUrls: ["https://example.com/"],
        sitemap: ["https://example.com/sitemap.xml"],
      },
      richResultsResult: {
        detectedItems: [],
      },
      mobileUsabilityResult: {
        verdict: "PASS",
      },
    },
  };

  try {
    const result = await collectAndWriteSearchConsoleUrlInspection({
      outputDir,
      siteUrl: "https://example.com/",
      configuredMaximumRaw: "5",
      languageCode: "ja",
      fetchAccessTokenImpl: async () => "token",
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        const body = JSON.parse(options.body);

        if (body.inspectionUrl.endsWith("/failure.html")) {
          return jsonResponse(
            {
              error: {
                message: "Inspection failed for fixture URL.",
              },
            },
            {
              status: 500,
            },
          );
        }

        return jsonResponse(successBody);
      },
      now: () => new Date("2026-07-21T00:00:00.000Z"),
    });

    assert.equal(result.inspectedUrls.length, 2);
    assert.equal(result.inspectionResults.length, 1);
    assert.equal(result.requestErrors.length, 1);
    assert.deepEqual(result.inspectionResults[0].response, successBody);
    assert.equal(
      result.requestErrors[0].error,
      "Inspection failed for fixture URL.",
    );
    assert.deepEqual(result.summaryCounts.byCoverageState, {
      "Submitted and indexed": 1,
    });
    assert.deepEqual(result.summaryCounts.byRobotsTxtState, {
      ALLOWED: 1,
    });
    assert.equal(
      requests.every(
        (request) =>
          request.url === URL_INSPECTION_ENDPOINT &&
          request.options.method === "POST",
      ),
      true,
    );
    assert.equal(
      requests.every((request) => {
        const body = JSON.parse(request.options.body);

        return (
          body.siteUrl === "https://example.com/" &&
          body.languageCode === "ja" &&
          Object.keys(body).sort().join(",") ===
            "inspectionUrl,languageCode,siteUrl"
        );
      }),
      true,
    );

    const auditBundle = await readAuditBundle(outputDir);
    assert.deepEqual(auditBundle.searchConsole.preserved, true);
    assert.deepEqual(
      auditBundle.searchConsoleUrlInspection.inspectionResults[0].response,
      successBody,
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

async function createAuditBundle(bundle) {
  const outputDir = await mkdtemp(path.join(tmpdir(), "url-inspection-"));

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
