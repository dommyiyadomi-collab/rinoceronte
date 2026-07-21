import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectSiteAudit,
  extractHtmlEvidence,
  normalizeSiteBaseUrl,
  parseSitemapXml,
} from "./collect-site-crawl.mjs";

test("parses urlset sitemap fixtures and excludes external-origin URLs", async () => {
  const baseUrl = "https://example.com";
  const xml = await readFixture("basic-urlset.xml", baseUrl);
  const parsed = parseSitemapXml({
    xml,
    sourceUrl: `${baseUrl}/sitemap.xml`,
    baseUrl: normalizeSiteBaseUrl(baseUrl),
  });

  assert.equal(parsed.type, "urlset");
  assert.equal(parsed.urls.length, 3);
  assert.deepEqual(
    parsed.urls.map((entry) => entry.url),
    [
      "https://example.com/",
      "https://example.com/about.html",
      "https://example.com/about.html",
    ],
  );
  assert.deepEqual(parsed.excludedExternalUrls, [
    {
      url: "https://external.example/outside.html",
      source: "https://example.com/sitemap.xml",
      reason: "outside SITE_BASE_URL origin",
    },
  ]);
});

test("records malformed sitemap XML as a collection error", async () => {
  const xml = await readFixture("malformed-sitemap.xml", "https://example.com");
  const parsed = parseSitemapXml({
    xml,
    sourceUrl: "https://example.com/sitemap.xml",
    baseUrl: normalizeSiteBaseUrl("https://example.com"),
  });

  assert.equal(parsed.type, null);
  assert.deepEqual(parsed.urls, []);
  assert.match(parsed.errors[0], /Malformed sitemap XML/);
});

test("extracts HTML metadata and normalizes only internal HTTP links", async () => {
  const html = await readFixture("page.html", "https://example.com");
  const evidence = extractHtmlEvidence({
    html,
    pageUrl: "https://example.com/about.html",
    baseUrl: normalizeSiteBaseUrl("https://example.com"),
    sitemapUrlSet: new Set([
      "https://example.com/",
      "https://example.com/contact.html",
    ]),
  });

  assert.equal(evidence.title, "Fixture Page");
  assert.equal(evidence.metaDescription, "Fixture meta description.");
  assert.equal(evidence.canonicalUrl, "https://example.com/about.html");
  assert.equal(evidence.metaRobots, "noindex, follow");
  assert.equal(evidence.h1Count, 1);
  assert.equal(evidence.htmlLang, "en");
  assert.deepEqual(
    evidence.internalLinks.map((link) => link.url),
    [
      "https://example.com/",
      "https://example.com/broken.html",
      "https://example.com/contact.html",
      "https://example.com/external-redirect.html",
      "https://example.com/missing-sitemap.html",
      "https://example.com/search?a=1&b=2",
    ],
  );
  assert.equal(
    evidence.internalLinks.find(
      (link) => link.url === "https://example.com/contact.html",
    ).inSitemap,
    true,
  );
});

test("collects sitemap index URLs, deduplicates them, and checks broken internal links locally", async () => {
  const server = await startFixtureServer();
  const outputDir = await mkdtemp(path.join(tmpdir(), "site-crawl-"));

  try {
    await mkdir(outputDir, { recursive: true });
    await writeFile(
      path.join(outputDir, "audit-bundle.json"),
      `${JSON.stringify({
        searchConsole: { preserved: true },
        googleAnalytics: { preserved: true },
      })}\n`,
      "utf8",
    );

    const { siteInventory, siteCrawl } = await collectSiteAudit({
      outputDir,
      siteBaseUrl: server.baseUrl,
      fetchImpl: server.fetchImpl,
      now: () => new Date("2026-07-21T00:00:00.000Z"),
      config: {
        requestTimeoutMs: 5_000,
        pageConcurrency: 2,
        linkCheckConcurrency: 2,
      },
    });

    assert.equal(siteInventory.baseUrl, server.baseUrl);
    assert.equal(siteInventory.counts.normalizedUrls, 5);
    assert.equal(siteInventory.counts.duplicateUrls, 1);
    assert.equal(siteInventory.counts.excludedExternalUrls, 1);
    assert.deepEqual(
      siteInventory.urlInventory.map((entry) => entry.url),
      [
        `${server.baseUrl}`,
        `${server.baseUrl}about.html`,
        `${server.baseUrl}contact.html`,
        `${server.baseUrl}external-redirect.html`,
        `${server.baseUrl}missing-sitemap.html`,
      ],
    );

    assert.equal(siteCrawl.summaryCounts.sitemapUrls, 5);
    assert.equal(siteCrawl.summaryCounts.successfulPages, 3);
    assert.equal(siteCrawl.summaryCounts.internalLinksOutsideSitemap, 2);
    assert.equal(siteCrawl.summaryCounts.brokenInternalLinks, 3);

    const successfulSitemapLink = siteCrawl.internalLinkChecks.find((link) =>
      link.url.endsWith("/contact.html"),
    );
    assert.equal(successfulSitemapLink.inSitemap, true);
    assert.equal(successfulSitemapLink.checked, true);
    assert.equal(successfulSitemapLink.checkSource, "pageResults");
    assert.equal(successfulSitemapLink.matchType, "requestedUrl");
    assert.equal(successfulSitemapLink.status, 200);
    assert.equal(successfulSitemapLink.ok, true);

    const brokenSitemapLink = siteCrawl.internalLinkChecks.find((link) =>
      link.url.endsWith("/missing-sitemap.html"),
    );
    assert.equal(brokenSitemapLink.inSitemap, true);
    assert.equal(brokenSitemapLink.checked, true);
    assert.equal(brokenSitemapLink.checkSource, "pageResults");
    assert.equal(brokenSitemapLink.status, 404);
    assert.equal(brokenSitemapLink.ok, false);

    const brokenOutsideSitemapLink = siteCrawl.internalLinkChecks.find((link) =>
      link.url.endsWith("/broken.html"),
    );
    assert.equal(brokenOutsideSitemapLink.inSitemap, false);
    assert.equal(brokenOutsideSitemapLink.checked, true);
    assert.equal(brokenOutsideSitemapLink.checkSource, "network");
    assert.equal(brokenOutsideSitemapLink.method, "HEAD");
    assert.equal(brokenOutsideSitemapLink.status, 404);
    assert.equal(brokenOutsideSitemapLink.ok, false);

    const externalRedirectPage = siteCrawl.pageResults.find((page) =>
      page.requestedUrl.endsWith("/external-redirect.html"),
    );
    assert.equal(externalRedirectPage.status, 302);
    assert.equal(externalRedirectPage.ok, false);
    assert.deepEqual(externalRedirectPage.redirectStop, {
      reason: "out_of_origin",
      destinationUrl: "https://external.example/landing.html",
    });
    assert.equal(externalRedirectPage.redirectChain.length, 1);
    assert.equal(externalRedirectPage.redirectChain[0].followed, false);
    assert.equal(
      externalRedirectPage.redirectChain[0].blockedDestinationUrl,
      "https://external.example/landing.html",
    );
    assert.equal(externalRedirectPage.fetchedBodyBytes, 0);
    assert.equal(
      server.fetchRequests.some((request) =>
        request.url.startsWith("https://external.example/"),
      ),
      false,
    );

    const auditBundle = JSON.parse(
      await readFile(path.join(outputDir, "audit-bundle.json"), "utf8"),
    );
    assert.deepEqual(auditBundle.searchConsole, { preserved: true });
    assert.deepEqual(auditBundle.googleAnalytics, { preserved: true });
    assert.ok(auditBundle.siteInventory);
    assert.ok(auditBundle.siteCrawl);

    assert.equal(
      server.requests.some((request) => request.method === "POST"),
      false,
    );
    assert.equal(
      server.requests.some(
        (request) =>
          request.method === "GET" && request.url === "/search?a=1&b=2",
      ),
      false,
    );
  } finally {
    await server.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});

async function readFixture(name, baseUrl) {
  const raw = await readFile(
    new URL(`./fixtures/site-crawl/${name}`, import.meta.url),
    "utf8",
  );
  return raw.replaceAll("{{BASE_URL}}", baseUrl.replace(/\/$/, ""));
}

async function startFixtureServer() {
  const requests = [];
  const fetchRequests = [];
  const pageHtml = await readFixture("page.html", "http://127.0.0.1");
  const server = createServer(async (request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
    });

    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    if (request.url === "/robots.txt") {
      sendFixtureResponse({ request, response, body: "User-agent: *\nAllow: /\n\nSitemap: /sitemap.xml\n" });
      return;
    }

    if (request.url === "/sitemap.xml") {
      sendFixtureResponse({
        request,
        response,
        body: await readFixture("sitemap-index.xml", baseUrl),
        contentType: "application/xml; charset=utf-8",
      });
      return;
    }

    if (request.url === "/child-a.xml") {
      sendFixtureResponse({
        request,
        response,
        body: await readFixture("child-a.xml", baseUrl),
        contentType: "application/xml; charset=utf-8",
      });
      return;
    }

    if (request.url === "/child-b.xml") {
      sendFixtureResponse({
        request,
        response,
        body: await readFixture("child-b.xml", baseUrl),
        contentType: "application/xml; charset=utf-8",
      });
      return;
    }

    if (["/", "/about.html", "/contact.html"].includes(request.url)) {
      sendFixtureResponse({
        request,
        response,
        body: pageHtml,
        contentType: "text/html; charset=utf-8",
      });
      return;
    }

    if (request.url === "/external-redirect.html") {
      response.statusCode = 302;
      response.setHeader("location", "https://external.example/landing.html");
      response.setHeader("content-length", "0");
      response.end();
      return;
    }

    if (request.url === "/missing-sitemap.html") {
      sendFixtureResponse({
        request,
        response,
        status: 404,
        body: "Not found",
      });
      return;
    }

    if (request.url === "/search?a=1&b=2") {
      sendFixtureResponse({
        request,
        response,
        body: "Search placeholder",
      });
      return;
    }

    if (request.url === "/broken.html") {
      sendFixtureResponse({
        request,
        response,
        status: 404,
        body: "Not found",
      });
      return;
    }

    sendFixtureResponse({
      request,
      response,
      status: 404,
      body: "Not found",
    });
  });

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}/`;
  const baseOrigin = new URL(baseUrl).origin;

  return {
    baseUrl,
    requests,
    fetchRequests,
    fetchImpl: async (url, init) => {
      const requestUrl = typeof url === "string" ? url : url.url;
      fetchRequests.push({
        method: init?.method ?? "GET",
        url: requestUrl,
      });

      if (new URL(requestUrl).origin !== baseOrigin) {
        throw new Error(`External fixture request attempted: ${requestUrl}`);
      }

      return fetch(url, init);
    },
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function sendFixtureResponse({
  request,
  response,
  status = 200,
  body = "",
  contentType = "text/plain; charset=utf-8",
}) {
  response.statusCode = status;
  response.setHeader("content-type", contentType);
  response.setHeader("content-length", Buffer.byteLength(body, "utf8"));
  response.end(request.method === "HEAD" ? "" : body);
}
