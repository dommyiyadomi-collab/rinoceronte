import assert from "node:assert/strict";
import test from "node:test";

import {
  collectSearchConsoleSitemaps,
  normalizeSiteUrl,
} from "./collect-search-console-sitemaps.mjs";

test("normalizes Search Console URL-prefix and domain properties", () => {
  assert.equal(
    normalizeSiteUrl(" https://example.com/ "),
    "https://example.com/",
  );
  assert.equal(
    normalizeSiteUrl(" sc-domain:example.com "),
    "sc-domain:example.com",
  );
  assert.throws(() => normalizeSiteUrl("example.com"), /property URL/);
});

test("collects root sitemaps and sitemap index entries", async () => {
  const requestedUrls = [];
  const fetchImpl = async (url, options) => {
    requestedUrls.push({ url, options });
    const parsedUrl = new URL(url);
    const sitemapIndex = parsedUrl.searchParams.get("sitemapIndex");

    if (!sitemapIndex) {
      return jsonResponse({
        sitemap: [
          {
            path: "https://example.com/sitemap.xml",
            lastSubmitted: "2026-07-01T00:00:00.000Z",
            lastDownloaded: "2026-07-02T00:00:00.000Z",
            isPending: false,
            isSitemapsIndex: true,
            type: "sitemap",
            warnings: 1,
            errors: 0,
            contents: [{ type: "web", submitted: 2 }],
          },
        ],
      });
    }

    assert.equal(sitemapIndex, "https://example.com/sitemap.xml");

    return jsonResponse({
      sitemap: [
        {
          path: "https://example.com/pages.xml",
          lastDownloaded: "2026-07-03T00:00:00.000Z",
          isPending: false,
          isSitemapsIndex: false,
          type: "sitemap",
          warnings: 0,
          errors: 2,
          contents: [{ type: "web", submitted: 4 }],
        },
      ],
    });
  };

  const result = await collectSearchConsoleSitemaps({
    accessToken: "token",
    fetchImpl,
    now: () => new Date("2026-07-21T00:00:00.000Z"),
    siteUrl: "https://example.com/",
  });

  assert.equal(result.generatedAt, "2026-07-21T00:00:00.000Z");
  assert.equal(result.property, "https://example.com/");
  assert.equal(result.collectorVersion, "1.0.0");
  assert.equal(result.apiVersion, "webmasters/v3");
  assert.equal(result.sitemaps.length, 2);
  assert.deepEqual(
    result.sitemaps.map((sitemap) => sitemap.path),
    ["https://example.com/pages.xml", "https://example.com/sitemap.xml"],
  );
  assert.equal(result.summaryCounts.totalSitemaps, 2);
  assert.equal(result.summaryCounts.sitemapIndexes, 1);
  assert.equal(result.summaryCounts.withWarnings, 1);
  assert.equal(result.summaryCounts.withErrors, 1);
  assert.equal(result.summaryCounts.submittedUrls, 6);
  assert.equal(requestedUrls.length, 2);
  assert.equal(requestedUrls[0].options.method, "GET");
  assert.equal(
    requestedUrls[0].options.headers.authorization,
    "Bearer token",
  );
});

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
    },
    status: 200,
    ...init,
  });
}
