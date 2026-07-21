#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as cheerio from "cheerio";
import { XMLParser, XMLValidator } from "fast-xml-parser";

export const DEFAULT_CONFIG = Object.freeze({
  userAgent: "JapanRemoteGuide-DailySiteAudit/2.0 (read-only sitemap crawl)",
  requestTimeoutMs: 15_000,
  maxRedirects: 8,
  maxSitemapFiles: 20,
  maxSitemapUrls: 1_000,
  maxBodyBytes: 2_000_000,
  pageConcurrency: 4,
  linkCheckConcurrency: 6,
});

class CollectionError extends Error {}

const XML_PARSER = new XMLParser({
  ignoreAttributes: false,
  parseAttributeValue: false,
  parseTagValue: false,
  removeNSPrefix: true,
  trimValues: true,
});

export async function main({
  argv = process.argv,
  env = process.env,
  fetchImpl = fetch,
  now = () => new Date(),
} = {}) {
  const outputDir = argv[2];

  if (!outputDir) {
    throw new CollectionError(
      "Missing output directory argument. Usage: node scripts/collect-site-crawl.mjs out/audit-bundle",
    );
  }

  const siteBaseUrl = normalizeSiteBaseUrl(env.SITE_BASE_URL);
  const { siteInventory, siteCrawl } = await collectSiteAudit({
    outputDir,
    siteBaseUrl,
    fetchImpl,
    now,
  });

  console.log(
    `Collected ${siteInventory.counts.normalizedUrls} sitemap URL(s) and crawled ${siteCrawl.pageResults.length} page(s) for ${siteInventory.baseUrl}.`,
  );
}

export async function collectSiteAudit({
  outputDir,
  siteBaseUrl,
  fetchImpl = fetch,
  now = () => new Date(),
  config = {},
}) {
  if (!outputDir) {
    throw new CollectionError("Missing output directory for site crawl output.");
  }

  const crawlConfig = { ...DEFAULT_CONFIG, ...config };
  const baseUrl = siteBaseUrl instanceof URL
    ? siteBaseUrl
    : normalizeSiteBaseUrl(siteBaseUrl);
  const generatedAt = now().toISOString();
  const baseUrlHref = baseUrl.href;
  const robotsUrl = new URL("robots.txt", baseUrl).href;
  const sitemapUrl = new URL("sitemap.xml", baseUrl).href;

  const homeFetch = await fetchTextResource(baseUrlHref, {
    fetchImpl,
    config: crawlConfig,
  });
  const robotsFetch = await fetchTextResource(robotsUrl, {
    fetchImpl,
    config: crawlConfig,
  });
  const robotsEvidence = buildRobotsEvidence(robotsFetch);
  const sitemapInventory = await collectSitemapInventory({
    rootSitemapUrl: sitemapUrl,
    baseUrl,
    fetchImpl,
    config: crawlConfig,
  });
  const collectionErrors = [
    describeFetchError("SITE_BASE_URL/", homeFetch),
    describeFetchError("robots.txt", robotsFetch),
    ...sitemapInventory.errors,
  ].filter(Boolean);
  const collectionWarnings = [
    describeFetchWarning("SITE_BASE_URL/", homeFetch),
    describeFetchWarning("robots.txt", robotsFetch),
    ...sitemapInventory.warnings,
  ].filter(Boolean);
  const urlInventory = sitemapInventory.urls.map((entry) => ({
    url: entry.url,
    sources: [...entry.sources].sort(),
    originalLocs: [...entry.originalLocs].sort(),
  }));
  const inventoryUrls = urlInventory.map((entry) => entry.url);
  const sitemapUrlSet = new Set(inventoryUrls);

  const siteInventory = {
    generatedAt,
    baseUrl: baseUrlHref,
    siteFetches: {
      home: stripBody(homeFetch),
    },
    sitemapSources: sitemapInventory.sources,
    robotsEvidence,
    urlInventory,
    counts: {
      sitemapSources: sitemapInventory.sources.length,
      normalizedUrls: urlInventory.length,
      duplicateUrls: sitemapInventory.duplicateUrls,
      excludedExternalUrls: sitemapInventory.excludedExternalUrls.length,
      errors: collectionErrors.length,
      warnings: collectionWarnings.length,
    },
    excludedExternalUrls: sitemapInventory.excludedExternalUrls,
    errors: collectionErrors,
    warnings: collectionWarnings,
  };

  const pageResults = await mapWithConcurrency(
    inventoryUrls,
    crawlConfig.pageConcurrency,
    (url) =>
      crawlPage({
        url,
        baseUrl,
        sitemapUrlSet,
        fetchImpl,
        config: crawlConfig,
      }),
  );
  const internalLinkChecks = await collectInternalLinkChecks({
    pageResults,
    sitemapUrlSet,
    fetchImpl,
    config: crawlConfig,
  });
  const siteCrawl = {
    generatedAt,
    baseUrl: baseUrlHref,
    crawlConfiguration: {
      userAgent: crawlConfig.userAgent,
      requestTimeoutMs: crawlConfig.requestTimeoutMs,
      maxRedirects: crawlConfig.maxRedirects,
      maxSitemapFiles: crawlConfig.maxSitemapFiles,
      maxSitemapUrls: crawlConfig.maxSitemapUrls,
      maxBodyBytes: crawlConfig.maxBodyBytes,
      pageConcurrency: crawlConfig.pageConcurrency,
      linkCheckConcurrency: crawlConfig.linkCheckConcurrency,
      crawlSeeds: "sitemap.xml only",
      linkDiscoveryPolicy:
        "Internal links are availability-checked but are not crawl seeds.",
      javascriptExecution: false,
      requestMethods: ["GET", "HEAD for internal link availability checks"],
    },
    pageResults,
    internalLinkChecks,
    summaryCounts: buildSummaryCounts({
      pageResults,
      internalLinkChecks,
      sitemapUrlCount: inventoryUrls.length,
    }),
  };

  await mkdir(outputDir, { recursive: true });
  await writeJson(path.join(outputDir, "site-url-inventory.json"), siteInventory);
  await writeJson(path.join(outputDir, "site-crawl.json"), siteCrawl);
  await upsertAuditBundle(outputDir, { siteInventory, siteCrawl });

  return {
    siteInventory,
    siteCrawl,
  };
}

export function normalizeSiteBaseUrl(rawBaseUrl) {
  if (!rawBaseUrl || !String(rawBaseUrl).trim()) {
    throw new CollectionError(
      "SITE_BASE_URL is required for site crawl collection.",
    );
  }

  let baseUrl;

  try {
    baseUrl = new URL(String(rawBaseUrl).trim());
  } catch {
    throw new CollectionError(
      "SITE_BASE_URL must be a valid absolute HTTP or HTTPS URL.",
    );
  }

  if (!["http:", "https:"].includes(baseUrl.protocol)) {
    throw new CollectionError(
      "SITE_BASE_URL must use the http: or https: protocol.",
    );
  }

  if (baseUrl.username || baseUrl.password) {
    throw new CollectionError("SITE_BASE_URL must not include credentials.");
  }

  baseUrl.hash = "";
  baseUrl.search = "";

  if (!baseUrl.pathname.endsWith("/")) {
    baseUrl.pathname = `${baseUrl.pathname}/`;
  }

  return baseUrl;
}

async function collectSitemapInventory({
  rootSitemapUrl,
  baseUrl,
  fetchImpl,
  config,
}) {
  const sources = [];
  const urlsByHref = new Map();
  const excludedExternalUrls = [];
  const errors = [];
  const warnings = [];
  const visitedSitemaps = new Set();
  const queue = [rootSitemapUrl];
  let duplicateUrls = 0;

  while (queue.length > 0) {
    if (visitedSitemaps.size >= config.maxSitemapFiles) {
      warnings.push(
        `Sitemap file limit reached at ${config.maxSitemapFiles}; remaining sitemap files were not fetched.`,
      );
      break;
    }

    const requestedUrl = queue.shift();
    const normalizedSitemapUrl = normalizeHttpUrl(requestedUrl, baseUrl.href);

    if (!normalizedSitemapUrl.ok) {
      warnings.push(`Skipped invalid sitemap URL: ${requestedUrl}`);
      continue;
    }

    if (normalizedSitemapUrl.url.origin !== baseUrl.origin) {
      warnings.push(
        `Skipped out-of-origin sitemap file: ${normalizedSitemapUrl.url.href}`,
      );
      continue;
    }

    const sitemapHref = normalizedSitemapUrl.url.href;

    if (visitedSitemaps.has(sitemapHref)) {
      warnings.push(`Skipped repeated sitemap file: ${sitemapHref}`);
      continue;
    }

    visitedSitemaps.add(sitemapHref);

    const fetchResult = await fetchTextResource(sitemapHref, {
      fetchImpl,
      config,
    });
    const sourceRecord = {
      ...stripBody(fetchResult),
      type: null,
      urlCount: 0,
      childSitemapCount: 0,
      errors: [],
      warnings: [],
    };

    if (!fetchResult.ok || !fetchResult.bodyText) {
      const message = fetchResult.error
        ? `Sitemap fetch failed for ${sitemapHref}: ${fetchResult.error.message}`
        : `Sitemap fetch failed for ${sitemapHref} with HTTP ${fetchResult.status}.`;
      sourceRecord.errors.push(message);
      errors.push(message);
      sources.push(sourceRecord);
      continue;
    }

    const parsed = parseSitemapXml({
      xml: fetchResult.bodyText,
      sourceUrl: fetchResult.finalUrl ?? sitemapHref,
      baseUrl,
    });
    sourceRecord.type = parsed.type;
    sourceRecord.urlCount = parsed.urls.length;
    sourceRecord.childSitemapCount = parsed.childSitemaps.length;
    sourceRecord.errors.push(...parsed.errors);
    sourceRecord.warnings.push(...parsed.warnings);
    sources.push(sourceRecord);
    errors.push(...parsed.errors);
    warnings.push(...parsed.warnings);
    excludedExternalUrls.push(...parsed.excludedExternalUrls);

    for (const parsedUrl of parsed.urls) {
      if (urlsByHref.size >= config.maxSitemapUrls) {
        warnings.push(
          `Sitemap URL limit reached at ${config.maxSitemapUrls}; additional URLs were skipped.`,
        );
        break;
      }

      const existing = urlsByHref.get(parsedUrl.url);

      if (existing) {
        duplicateUrls += 1;
        existing.sources.add(parsedUrl.source);
        existing.originalLocs.add(parsedUrl.originalLoc);
      } else {
        urlsByHref.set(parsedUrl.url, {
          url: parsedUrl.url,
          sources: new Set([parsedUrl.source]),
          originalLocs: new Set([parsedUrl.originalLoc]),
        });
      }
    }

    for (const childSitemap of parsed.childSitemaps) {
      if (visitedSitemaps.has(childSitemap.url)) {
        warnings.push(`Skipped repeated sitemap file: ${childSitemap.url}`);
        continue;
      }

      queue.push(childSitemap.url);
    }
  }

  return {
    sources,
    urls: [...urlsByHref.values()].sort((a, b) => a.url.localeCompare(b.url)),
    duplicateUrls,
    excludedExternalUrls: excludedExternalUrls.sort((a, b) =>
      a.url.localeCompare(b.url),
    ),
    errors,
    warnings,
  };
}

export function parseSitemapXml({ xml, sourceUrl, baseUrl }) {
  const validation = XMLValidator.validate(xml);

  if (validation !== true) {
    const location = validation.err
      ? `line ${validation.err.line}, column ${validation.err.col}`
      : "unknown location";

    return {
      type: null,
      urls: [],
      childSitemaps: [],
      excludedExternalUrls: [],
      errors: [`Malformed sitemap XML in ${sourceUrl} (${location}).`],
      warnings: [],
    };
  }

  let parsed;

  try {
    parsed = XML_PARSER.parse(xml);
  } catch (error) {
    return {
      type: null,
      urls: [],
      childSitemaps: [],
      excludedExternalUrls: [],
      errors: [
        `Unable to parse sitemap XML in ${sourceUrl}: ${error instanceof Error ? error.message : String(error)}`,
      ],
      warnings: [],
    };
  }

  const root = parsed.urlset
    ? { type: "urlset", node: parsed.urlset }
    : parsed.sitemapindex
      ? { type: "sitemapindex", node: parsed.sitemapindex }
      : null;

  if (!root) {
    return {
      type: null,
      urls: [],
      childSitemaps: [],
      excludedExternalUrls: [],
      errors: [`Unsupported sitemap document in ${sourceUrl}.`],
      warnings: [],
    };
  }

  const warnings = [];
  const excludedExternalUrls = [];

  if (root.type === "urlset") {
    const urls = [];

    for (const entry of toArray(root.node.url)) {
      const loc = extractLoc(entry);

      if (!loc) {
        warnings.push(`Sitemap URL entry without loc in ${sourceUrl}.`);
        continue;
      }

      const normalized = normalizeHttpUrl(loc, sourceUrl);

      if (!normalized.ok) {
        warnings.push(`Skipped invalid sitemap loc in ${sourceUrl}: ${loc}`);
        continue;
      }

      if (normalized.url.origin !== baseUrl.origin) {
        excludedExternalUrls.push({
          url: normalized.url.href,
          source: sourceUrl,
          reason: "outside SITE_BASE_URL origin",
        });
        continue;
      }

      urls.push({
        url: normalized.url.href,
        originalLoc: loc,
        source: sourceUrl,
      });
    }

    return {
      type: root.type,
      urls,
      childSitemaps: [],
      excludedExternalUrls,
      errors: [],
      warnings,
    };
  }

  const childSitemaps = [];

  for (const entry of toArray(root.node.sitemap)) {
    const loc = extractLoc(entry);

    if (!loc) {
      warnings.push(`Sitemap index entry without loc in ${sourceUrl}.`);
      continue;
    }

    const normalized = normalizeHttpUrl(loc, sourceUrl);

    if (!normalized.ok) {
      warnings.push(`Skipped invalid child sitemap loc in ${sourceUrl}: ${loc}`);
      continue;
    }

    if (normalized.url.origin !== baseUrl.origin) {
      warnings.push(
        `Skipped out-of-origin child sitemap ${normalized.url.href} from ${sourceUrl}.`,
      );
      continue;
    }

    childSitemaps.push({
      url: normalized.url.href,
      originalLoc: loc,
      source: sourceUrl,
    });
  }

  return {
    type: root.type,
    urls: [],
    childSitemaps,
    excludedExternalUrls,
    errors: [],
    warnings,
  };
}

function extractLoc(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const loc = entry.loc;

  if (typeof loc === "string") {
    return loc.trim() || null;
  }

  if (Array.isArray(loc)) {
    return loc.find((value) => typeof value === "string" && value.trim())
      ?.trim() ?? null;
  }

  if (loc && typeof loc === "object" && typeof loc["#text"] === "string") {
    return loc["#text"].trim() || null;
  }

  return null;
}

function toArray(value) {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function buildRobotsEvidence(fetchResult) {
  const parsed = fetchResult.bodyText ? parseRobotsTxt(fetchResult.bodyText) : {
    sitemapLines: [],
    userAgentStarGroupExists: false,
    userAgentStarGroup: {
      allow: [],
      disallow: [],
    },
  };

  return {
    ...stripBody(fetchResult),
    declaredSitemaps: parsed.sitemapLines,
    userAgentStarGroupExists: parsed.userAgentStarGroupExists,
    userAgentStarGroup: parsed.userAgentStarGroup,
  };
}

export function parseRobotsTxt(text) {
  const sitemapLines = [];
  const groups = [];
  let currentAgents = [];
  let currentRules = [];

  const flushGroup = () => {
    if (currentAgents.length === 0) {
      currentRules = [];
      return;
    }

    groups.push({
      agents: currentAgents,
      allow: currentRules
        .filter((rule) => rule.type === "allow")
        .map((rule) => rule.value),
      disallow: currentRules
        .filter((rule) => rule.type === "disallow")
        .map((rule) => rule.value),
    });
    currentAgents = [];
    currentRules = [];
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#", 1)[0].trim();

    if (!line) {
      flushGroup();
      continue;
    }

    const separatorIndex = line.indexOf(":");

    if (separatorIndex === -1) {
      continue;
    }

    const field = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();

    if (field === "sitemap") {
      sitemapLines.push(value);
      continue;
    }

    if (field === "user-agent") {
      if (currentAgents.length > 0 && currentRules.length > 0) {
        flushGroup();
      }

      currentAgents.push(value.toLowerCase());
      continue;
    }

    if ((field === "allow" || field === "disallow") && currentAgents.length) {
      currentRules.push({
        type: field,
        value,
      });
    }
  }

  flushGroup();

  const starGroup = groups.find((group) => group.agents.includes("*"));

  return {
    sitemapLines,
    userAgentStarGroupExists: Boolean(starGroup),
    userAgentStarGroup: starGroup
      ? {
          allow: starGroup.allow,
          disallow: starGroup.disallow,
        }
      : {
          allow: [],
          disallow: [],
        },
  };
}

async function crawlPage({
  url,
  baseUrl,
  sitemapUrlSet,
  fetchImpl,
  config,
}) {
  const fetchResult = await fetchTextResource(url, {
    fetchImpl,
    config,
  });
  const pageResult = {
    requestedUrl: fetchResult.requestedUrl,
    finalUrl: fetchResult.finalUrl,
    redirectChain: fetchResult.redirectChain,
    status: fetchResult.status,
    ok: fetchResult.ok,
    contentType: fetchResult.contentType,
    responseTimeMs: fetchResult.responseTimeMs,
    contentLength: fetchResult.contentLength,
    fetchedBodyBytes: fetchResult.fetchedBodyBytes,
    bodyTruncated: fetchResult.bodyTruncated,
    title: null,
    metaDescription: null,
    canonicalUrl: null,
    metaRobots: null,
    h1Count: null,
    htmlLang: null,
    internalLinks: [],
    error: fetchResult.error,
  };

  if (!fetchResult.bodyText || !isHtmlContent(fetchResult.contentType)) {
    return pageResult;
  }

  const metadata = extractHtmlEvidence({
    html: fetchResult.bodyText,
    pageUrl: fetchResult.finalUrl ?? url,
    baseUrl,
    sitemapUrlSet,
  });

  return {
    ...pageResult,
    ...metadata,
  };
}

export function extractHtmlEvidence({
  html,
  pageUrl,
  baseUrl,
  sitemapUrlSet = new Set(),
}) {
  const $ = cheerio.load(html);
  const title = normalizeWhitespace($("head title").first().text());
  const canonicalHref = findCanonicalHref($);
  const internalLinks = extractInternalLinks({
    $,
    pageUrl,
    baseUrl,
    sitemapUrlSet,
  });

  return {
    title: title || null,
    metaDescription: findMetaContent($, "description"),
    canonicalUrl: canonicalHref
      ? normalizeAbsoluteUrl(canonicalHref, pageUrl)
      : null,
    metaRobots: findMetaContent($, "robots"),
    h1Count: $("h1").length,
    htmlLang: $("html").first().attr("lang")?.trim() || null,
    internalLinks,
  };
}

function findMetaContent($, name) {
  const match = $("meta").toArray().find((element) => {
    const metaName = $(element).attr("name");
    return metaName?.trim().toLowerCase() === name;
  });

  return match ? $(match).attr("content")?.trim() || null : null;
}

function findCanonicalHref($) {
  const match = $("link").toArray().find((element) => {
    const rel = $(element).attr("rel");
    return rel
      ?.split(/\s+/)
      .map((token) => token.toLowerCase())
      .includes("canonical");
  });

  return match ? $(match).attr("href")?.trim() || null : null;
}

export function extractInternalLinks({ $, pageUrl, baseUrl, sitemapUrlSet }) {
  const linksByUrl = new Map();

  for (const element of $("a[href]").toArray()) {
    const href = $(element).attr("href")?.trim();
    const normalized = normalizeInternalLink(href, pageUrl, baseUrl);

    if (!normalized) {
      continue;
    }

    const existing = linksByUrl.get(normalized.url);

    if (existing) {
      existing.sourceHrefs.add(href);
      existing.occurrences += 1;
    } else {
      linksByUrl.set(normalized.url, {
        url: normalized.url,
        inSitemap: sitemapUrlSet.has(normalized.url),
        sourceHrefs: new Set([href]),
        occurrences: 1,
      });
    }
  }

  return [...linksByUrl.values()]
    .map((link) => ({
      url: link.url,
      inSitemap: link.inSitemap,
      sourceHrefs: [...link.sourceHrefs].sort(),
      occurrences: link.occurrences,
    }))
    .sort((a, b) => a.url.localeCompare(b.url));
}

export function normalizeInternalLink(rawHref, pageUrl, baseUrl) {
  if (!rawHref) {
    return null;
  }

  const trimmedHref = rawHref.trim();

  if (!trimmedHref || trimmedHref.startsWith("#")) {
    return null;
  }

  const normalized = normalizeHttpUrl(trimmedHref, pageUrl);

  if (!normalized.ok) {
    return null;
  }

  if (normalized.url.origin !== baseUrl.origin) {
    return null;
  }

  return {
    url: normalized.url.href,
  };
}

async function collectInternalLinkChecks({
  pageResults,
  sitemapUrlSet,
  fetchImpl,
  config,
}) {
  const linksByUrl = new Map();

  for (const pageResult of pageResults) {
    for (const link of pageResult.internalLinks) {
      const existing = linksByUrl.get(link.url) ?? {
        url: link.url,
        inSitemap: sitemapUrlSet.has(link.url),
        sourcePages: new Set(),
        sourceHrefs: new Set(),
      };

      existing.sourcePages.add(pageResult.finalUrl ?? pageResult.requestedUrl);

      for (const sourceHref of link.sourceHrefs) {
        existing.sourceHrefs.add(sourceHref);
      }

      linksByUrl.set(link.url, existing);
    }
  }

  const linkTargets = [...linksByUrl.values()]
    .map((link) => ({
      url: link.url,
      inSitemap: link.inSitemap,
      sourcePages: [...link.sourcePages].sort(),
      sourceHrefs: [...link.sourceHrefs].sort(),
    }))
    .sort((a, b) => a.url.localeCompare(b.url));
  const sitemapTargets = linkTargets
    .filter((link) => link.inSitemap)
    .map((link) => ({
      ...link,
      checked: false,
      checkReason: "present in sitemap inventory and crawled as a sitemap URL",
      method: null,
      finalUrl: null,
      redirectChain: [],
      status: null,
      ok: null,
      responseTimeMs: null,
      contentType: null,
      contentLength: null,
      error: null,
    }));
  const outsideSitemapTargets = linkTargets.filter((link) => !link.inSitemap);
  const outsideChecks = await mapWithConcurrency(
    outsideSitemapTargets,
    config.linkCheckConcurrency,
    (link) => checkInternalLinkAvailability({ link, fetchImpl, config }),
  );

  return [...sitemapTargets, ...outsideChecks].sort((a, b) =>
    a.url.localeCompare(b.url),
  );
}

async function checkInternalLinkAvailability({ link, fetchImpl, config }) {
  const headResult = await fetchTextResource(link.url, {
    fetchImpl,
    config,
    method: "HEAD",
  });
  let result = headResult;
  let method = "HEAD";
  let checkReason = "HEAD availability check";

  if (shouldFallbackFromHead(headResult)) {
    result = await fetchTextResource(link.url, {
      fetchImpl,
      config,
      method: "GET",
    });
    method = "GET";
    checkReason = `GET fallback after HEAD ${
      headResult.status ? `HTTP ${headResult.status}` : "failure"
    }`;
  }

  return {
    ...link,
    checked: true,
    checkReason,
    method,
    finalUrl: result.finalUrl,
    redirectChain: result.redirectChain,
    status: result.status,
    ok: result.ok,
    responseTimeMs: result.responseTimeMs,
    contentType: result.contentType,
    contentLength: result.contentLength,
    error: result.error,
  };
}

function shouldFallbackFromHead(result) {
  return Boolean(result.error) || [405, 501].includes(result.status);
}

function buildSummaryCounts({
  pageResults,
  internalLinkChecks,
  sitemapUrlCount,
}) {
  const htmlPages = pageResults.filter((page) => isHtmlContent(page.contentType));
  const outsideSitemapLinks = internalLinkChecks.filter((link) => !link.inSitemap);

  return {
    sitemapUrls: sitemapUrlCount,
    successfulPages: pageResults.filter((page) => page.ok).length,
    redirectingPages: pageResults.filter(
      (page) => page.redirectChain.length > 0,
    ).length,
    clientErrors: pageResults.filter(
      (page) => page.status >= 400 && page.status < 500,
    ).length,
    serverErrors: pageResults.filter((page) => page.status >= 500).length,
    failedRequests: pageResults.filter((page) => page.error).length,
    pagesMissingTitle: htmlPages.filter((page) => !page.title).length,
    pagesMissingMetaDescription: htmlPages.filter(
      (page) => !page.metaDescription,
    ).length,
    pagesMissingCanonical: htmlPages.filter((page) => !page.canonicalUrl).length,
    pagesWithZeroH1: htmlPages.filter((page) => page.h1Count === 0).length,
    pagesWithMultipleH1: htmlPages.filter((page) => page.h1Count > 1).length,
    internalLinksOutsideSitemap: outsideSitemapLinks.length,
    brokenInternalLinks: outsideSitemapLinks.filter(
      (link) => link.error || link.ok === false || link.status >= 400,
    ).length,
  };
}

async function fetchTextResource(
  requestedUrl,
  { fetchImpl, config, method = "GET" },
) {
  const startedAt = Date.now();

  try {
    const { response, finalUrl, redirectChain } = await fetchWithRedirects(
      requestedUrl,
      {
        fetchImpl,
        config,
        method,
      },
    );
    const body = method === "HEAD"
      ? { text: "", bytes: 0, truncated: false }
      : await readResponseBody(response, config.maxBodyBytes);

    return {
      requestedUrl,
      finalUrl,
      redirectChain,
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get("content-type"),
      responseTimeMs: Date.now() - startedAt,
      contentLength: parseContentLength(response.headers.get("content-length")),
      fetchedBodyBytes: body.bytes,
      bodyTruncated: body.truncated,
      bodyText: body.text,
      error: null,
    };
  } catch (error) {
    return {
      requestedUrl,
      finalUrl: null,
      redirectChain: [],
      status: null,
      ok: false,
      contentType: null,
      responseTimeMs: Date.now() - startedAt,
      contentLength: null,
      fetchedBodyBytes: 0,
      bodyTruncated: false,
      bodyText: "",
      error: serializeError(error),
    };
  }
}

async function fetchWithRedirects(requestedUrl, { fetchImpl, config, method }) {
  let currentUrl = requestedUrl;
  const redirectChain = [];

  for (let redirectCount = 0; redirectCount <= config.maxRedirects; redirectCount += 1) {
    const response = await fetchImpl(currentUrl, {
      method,
      headers: {
        "user-agent": config.userAgent,
        accept:
          method === "HEAD"
            ? "*/*"
            : "text/html,application/xhtml+xml,application/xml,text/xml,text/plain,*/*;q=0.8",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });

    if (!isRedirectStatus(response.status)) {
      return {
        response,
        finalUrl: response.url || currentUrl,
        redirectChain,
      };
    }

    const location = response.headers.get("location");

    if (!location) {
      return {
        response,
        finalUrl: response.url || currentUrl,
        redirectChain,
      };
    }

    const nextUrl = new URL(location, currentUrl).href;
    redirectChain.push({
      fromUrl: currentUrl,
      status: response.status,
      location,
      toUrl: nextUrl,
    });
    currentUrl = nextUrl;
  }

  throw new Error(
    `Redirect limit exceeded after ${config.maxRedirects} redirect(s).`,
  );
}

function isRedirectStatus(status) {
  return [301, 302, 303, 307, 308].includes(status);
}

async function readResponseBody(response, maxBodyBytes) {
  if (!response.body) {
    const text = await response.text();
    const bytes = Buffer.byteLength(text, "utf8");

    return {
      text,
      bytes,
      truncated: bytes > maxBodyBytes,
    };
  }

  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    if (bytes + value.byteLength > maxBodyBytes) {
      const remainingBytes = Math.max(maxBodyBytes - bytes, 0);

      if (remainingBytes > 0) {
        chunks.push(value.slice(0, remainingBytes));
        bytes += remainingBytes;
      }

      truncated = true;
      await reader.cancel();
      break;
    }

    chunks.push(value);
    bytes += value.byteLength;
  }

  return {
    text: Buffer.concat(chunks).toString("utf8"),
    bytes,
    truncated,
  };
}

function normalizeHttpUrl(rawUrl, baseUrl) {
  try {
    const url = new URL(String(rawUrl).trim(), baseUrl);

    if (!["http:", "https:"].includes(url.protocol)) {
      return {
        ok: false,
        error: "non-http-url",
      };
    }

    url.username = "";
    url.password = "";
    url.hash = "";
    url.searchParams.sort();

    return {
      ok: true,
      url,
    };
  } catch {
    return {
      ok: false,
      error: "invalid-url",
    };
  }
}

function normalizeAbsoluteUrl(rawUrl, baseUrl) {
  const normalized = normalizeHttpUrl(rawUrl, baseUrl);
  return normalized.ok ? normalized.url.href : rawUrl;
}

function normalizeWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

function isHtmlContent(contentType) {
  return contentType?.toLowerCase().split(";", 1)[0].trim() === "text/html";
}

function parseContentLength(rawContentLength) {
  if (!rawContentLength) {
    return null;
  }

  const contentLength = Number(rawContentLength);

  return Number.isSafeInteger(contentLength) && contentLength >= 0
    ? contentLength
    : null;
}

function stripBody(fetchResult) {
  const { bodyText, ...metadata } = fetchResult;
  return metadata;
}

function describeFetchError(label, fetchResult) {
  if (!fetchResult.error) {
    return null;
  }

  return `${label} fetch failed: ${fetchResult.error.message}`;
}

function describeFetchWarning(label, fetchResult) {
  if (fetchResult.error || fetchResult.ok) {
    return null;
  }

  return `${label} returned HTTP ${fetchResult.status}.`;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, () => worker()),
  );

  return results;
}

async function upsertAuditBundle(outputDir, { siteInventory, siteCrawl }) {
  const auditBundlePath = path.join(outputDir, "audit-bundle.json");
  const auditBundle = await readExistingAuditBundle(auditBundlePath);

  await writeJson(auditBundlePath, {
    ...auditBundle,
    siteInventory,
    siteCrawl,
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

function serializeError(error) {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
  };
}

const isCli = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isCli) {
  main().catch((error) => {
    if (error instanceof CollectionError) {
      console.error(error.message);
    } else {
      console.error("Unexpected site crawl collection failure.");
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exit(1);
  });
}
