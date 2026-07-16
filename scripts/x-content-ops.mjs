#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const SITE_ORIGIN =
  process.env.JRG_SITE_ORIGIN || "https://japan-remote-guide.com";
const DEFAULT_REF = process.env.JRG_MONITOR_REF || "origin/main";
const STATE_PATH = "x/state/article-monitor.json";
const OUTPUT_ROOTS = [
  "x/drafts",
  "x/logs",
  "x/sources",
  "x/history",
  "x/archive",
  "x/analytics",
  "x/reports",
  "x/state",
];
const HIGH_RISK_TERMS = [
  "visa",
  "immigration",
  "status",
  "tax",
  "legal",
  "law",
  "insurance",
  "entry",
  "border",
  "weather",
  "warning",
  "advisory",
  "typhoon",
  "storm",
  "earthquake",
  "disaster",
  "transport",
  "flight",
  "train",
  "event",
];
const UTILITY_PAGES = new Set([
  "index.html",
  "about.html",
  "contact.html",
  "feedback.html",
  "privacy.html",
  "terms.html",
]);
const CLICKBAIT_TERMS = [
  "shocking",
  "secret",
  "guaranteed",
  "must see",
  "insane",
  "life-changing",
  "perfect for everyone",
];
const TIME_WINDOWS = [
  { key: "morning", label: "08:00-10:00 JST" },
  { key: "midday", label: "12:00-14:00 JST" },
  { key: "evening", label: "18:00-20:00 JST" },
  { key: "late", label: "21:00-23:00 JST" },
];

const args = parseArgs(process.argv.slice(2));
const startedAt = new Date();
const nowId = toFileStamp(startedAt);
const dryRun = Boolean(args["dry-run"]);
const includeUtility = Boolean(args["include-utility"]);
const skipFetch = Boolean(args["no-fetch"]);
const noStateUpdate = Boolean(args["no-update-state"]);
const skipSourceFetch = Boolean(args["skip-source-fetch"]);

for (const dir of OUTPUT_ROOTS) ensureDir(dir);

if (!skipFetch) {
  runGit(["fetch", "--quiet", "origin"], { allowFailure: true });
}

const untilRef = args.until || DEFAULT_REF;
const untilCommit = resolveCommit(untilRef) || resolveCommit("HEAD");
if (!untilCommit) fail("Could not resolve the target commit.");

const storedState = readJsonIfExists(STATE_PATH);
const sinceRef =
  args.since ||
  storedState?.lastProcessedCommit ||
  resolveCommit(`${untilCommit}^`) ||
  "";
const sinceCommit = sinceRef ? resolveCommit(sinceRef) || sinceRef : "";

const history = loadRecentHistory();
const analyticsSignals = loadAnalyticsSignals();
const changedFiles = collectChangedHtmlFiles(sinceCommit, untilCommit);
const articleUpdates = [];
const skippedFiles = [];

for (const fileChange of changedFiles) {
  const html = gitShow(`${untilCommit}:${fileChange.path}`);
  if (!html) continue;

  const article = parseArticle(html, fileChange.path);
  if (!includeUtility && UTILITY_PAGES.has(path.basename(fileChange.path))) {
    skippedFiles.push({ ...fileChange, reason: "utility page" });
    continue;
  }
  if (!isArticle(article)) {
    skippedFiles.push({ ...fileChange, reason: "not an article page" });
    continue;
  }

  const previousHtml = sinceCommit
    ? gitShow(`${sinceCommit}:${fileChange.previousPath || fileChange.path}`)
    : "";
  const previousArticle = previousHtml
    ? parseArticle(previousHtml, fileChange.previousPath || fileChange.path)
    : null;

  articleUpdates.push({
    change: fileChange,
    article,
    previousArticle,
    summary: summarizeArticleChange(fileChange, article, previousArticle),
  });
}

const results = [];
for (const update of articleUpdates) {
  const sourceChecks = skipSourceFetch
    ? update.article.sources.map((source) => ({
        ...source,
        checkedAt: startedAt.toISOString(),
        status: "skipped",
        reachable: false,
        note: "Network source check skipped by CLI flag.",
      }))
    : await verifySources(update.article.sources);
  const sourceGate = evaluateSourceGate(update.article, sourceChecks);
  const sourceRecordPath = writeSourceRecord(update, sourceChecks, sourceGate);
  const qualityContext = {
    history,
    analyticsSignals,
    sourceGate,
    sourceRecordPath,
  };
  const draft = buildDraft(update, qualityContext);
  const qualityGate = evaluateDraftQuality(draft, update, qualityContext);

  if (qualityGate.pass && !dryRun) {
    const draftPath = path.join(
      "x/drafts",
      `${nowId}-${slugify(update.article.slug)}.md`,
    );
    writeFile(
      draftPath,
      renderDraft(update, draft, qualityGate, sourceRecordPath, sourceGate),
    );
    results.push({
      article: update.article.path,
      status: "draft_saved",
      draftPath,
      sourceRecordPath,
      qualityGate,
    });
  } else {
    results.push({
      article: update.article.path,
      status: qualityGate.pass ? "dry_run_passed" : "held",
      sourceRecordPath,
      qualityGate,
    });
  }
}

const shouldWriteLog =
  Boolean(args["always-log"]) || changedFiles.length > 0 || articleUpdates.length > 0;
const logPath = shouldWriteLog
  ? writeRunLog({
      startedAt,
      sinceCommit,
      untilCommit,
      changedFiles,
      skippedFiles,
      articleUpdates,
      results,
      dryRun,
    })
  : "";

if (!dryRun && !noStateUpdate) {
  writeJson(STATE_PATH, {
    lastProcessedCommit: untilCommit,
    lastRunAt: startedAt.toISOString(),
    lastLogPath: logPath
      ? normalizePath(logPath)
      : storedState?.lastLogPath || "",
  });
}

console.log(
  [
    `X content ops checked ${changedFiles.length} changed HTML file(s).`,
    `${articleUpdates.length} article update(s) evaluated.`,
    `${results.filter((result) => result.status === "draft_saved").length} draft file(s) saved.`,
    `${results.filter((result) => result.status === "dry_run_passed").length} draft candidate set(s) passed in dry run.`,
    `${results.filter((result) => result.status === "held").length} article update(s) held.`,
    ...results
      .filter((result) => result.status === "held")
      .map((result) => {
        const failed = result.qualityGate.checks
          .filter((check) => !check.pass)
          .map((check) => check.detail)
          .join("; ");
        return `Held ${result.article}: ${failed}`;
      }),
    `Log: ${
      logPath
        ? dryRun
          ? `${logPath} (dry run, not written)`
          : logPath
        : "not written; no relevant changes"
    }`,
  ].join("\n"),
);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function writeFile(filePath, content) {
  ensureDir(path.dirname(filePath));
  writeFileSync(filePath, content, "utf8");
}

function writeJson(filePath, value) {
  writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJsonIfExists(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function runGit(gitArgs, options = {}) {
  try {
    return execFileSync("git", gitArgs, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (options.allowFailure) return "";
    throw error;
  }
}

function resolveCommit(ref) {
  if (!ref) return "";
  return runGit(["rev-parse", "--verify", ref], { allowFailure: true });
}

function gitShow(ref) {
  return runGit(["show", ref], { allowFailure: true });
}

function collectChangedHtmlFiles(sinceCommit, untilCommit) {
  const argsForDiff = sinceCommit
    ? ["diff", "--name-status", sinceCommit, untilCommit, "--", "public"]
    : ["diff-tree", "--root", "--name-status", "-r", untilCommit, "--", "public"];
  const output = runGit(argsForDiff, { allowFailure: true });
  if (!output) return [];

  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\t+/);
      const status = parts[0];
      if (status.startsWith("R")) {
        return { status, previousPath: normalizePath(parts[1]), path: normalizePath(parts[2]) };
      }
      return { status, path: normalizePath(parts[1]) };
    })
    .filter((entry) => entry.path.endsWith(".html"));
}

function parseArticle(html, filePath) {
  const withoutScripts = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ");
  const sourceSection = extractSourceSection(withoutScripts);
  const plainText = decodeHtml(
    withoutScripts.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
  );
  const title = firstMatch(withoutScripts, /<title>([\s\S]*?)<\/title>/i);
  const metaDescription = firstMatch(
    withoutScripts,
    /<meta\s+name=["']description["']\s+content=["']([^"']+)["'][^>]*>/i,
  );
  const ogType = firstMatch(
    withoutScripts,
    /<meta\s+property=["']og:type["']\s+content=["']([^"']+)["'][^>]*>/i,
  );
  const h1 = firstMatch(withoutScripts, /<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const h2s = allMatches(withoutScripts, /<h2[^>]*>([\s\S]*?)<\/h2>/gi).slice(0, 8);
  const h3s = allMatches(withoutScripts, /<h3[^>]*>([\s\S]*?)<\/h3>/gi).slice(0, 8);
  const lastReviewed = firstMatch(withoutScripts, /Last reviewed:\s*([^<]+)/i);
  const sources = extractSources(sourceSection);
  const relativeUrl = filePath.replace(/^public\//, "");
  const publicUrl =
    relativeUrl === "index.html"
      ? `${SITE_ORIGIN}/`
      : `${SITE_ORIGIN}/${relativeUrl}`;

  return {
    path: normalizePath(filePath),
    slug: relativeUrl.replace(/\.html$/i, ""),
    url: publicUrl,
    title: cleanInline(title),
    metaDescription: cleanInline(metaDescription),
    ogType: cleanInline(ogType).toLowerCase(),
    h1: cleanInline(h1),
    h2s: h2s.map(cleanInline).filter(Boolean),
    h3s: h3s.map(cleanInline).filter(Boolean),
    text: plainText,
    lastReviewed: cleanInline(lastReviewed),
    sources,
    highRiskTerms: HIGH_RISK_TERMS.filter((term) =>
      plainText.toLowerCase().includes(term),
    ),
  };
}

function extractSourceSection(html) {
  const sourceBox = firstMatch(
    html,
    /<section[^>]*class=["'][^"']*source-box[^"']*["'][^>]*>([\s\S]*?)<\/section>/i,
  );
  if (sourceBox) return sourceBox;
  const sourceTitleIndex = html.search(/Sources used/i);
  if (sourceTitleIndex < 0) return "";
  return html.slice(sourceTitleIndex, sourceTitleIndex + 6000);
}

function extractSources(html) {
  if (!html) return [];
  return allMatchesWithGroups(
    html,
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
  )
    .map(([url, label]) => {
      const cleanedUrl = decodeHtml(url.trim());
      const provider = cleanInline(label);
      const priority = classifySource(cleanedUrl);
      return {
        url: cleanedUrl,
        provider,
        priority: priority.label,
        priorityRank: priority.rank,
        official: priority.rank <= 5,
      };
    })
    .filter((source) => source.url.startsWith("http"));
}

function firstMatch(text, pattern) {
  const match = pattern.exec(text);
  return match ? match[1] : "";
}

function allMatches(text, pattern) {
  return Array.from(text.matchAll(pattern), (match) => match[1]);
}

function allMatchesWithGroups(text, pattern) {
  return Array.from(text.matchAll(pattern), (match) => match.slice(1));
}

function cleanInline(value) {
  return decodeHtml(String(value || "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function classifySource(url) {
  let hostname = "";
  try {
    hostname = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return { label: "unclassified", rank: 99 };
  }

  if (hostname.endsWith(".go.jp") || hostname === "digital.go.jp") {
    return { label: "Japanese government official site", rank: 1 };
  }
  if (hostname.endsWith(".lg.jp")) {
    return { label: "local government official site", rank: 2 };
  }
  if (
    [
      "gotokyo.org",
      "gofukuoka.jp",
      "osaka-info.jp",
      "kyoto.travel",
      "sapporo.travel",
      "visitokinawajapan.com",
    ].includes(hostname)
  ) {
    return { label: "municipality or official tourism site", rank: 2 };
  }
  if (
    [
      "jnto.go.jp",
      "japan.travel",
      "tcvb.or.jp",
      "data.jma.go.jp",
    ].some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))
  ) {
    return { label: "public institution or official tourism agency", rank: 3 };
  }
  if (hostname.endsWith(".or.jp") || hostname.endsWith(".ac.jp")) {
    return { label: "public or institutional primary source", rank: 5 };
  }
  return { label: "unclassified", rank: 99 };
}

function isArticle(article) {
  return (
    article.ogType === "article" ||
    (article.sources.length > 0 && article.h2s.some((heading) => /sources used/i.test(heading)))
  );
}

async function verifySources(sources) {
  const checked = [];
  for (const source of sources) {
    checked.push(await verifySource(source));
  }
  return checked;
}

async function verifySource(source) {
  const checkedAt = new Date().toISOString();
  const timeoutMs = Number(args["source-timeout-ms"] || 12000);
  const headers = {
    accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
    "user-agent":
      "JapanRemoteGuideContentOps/1.0 (+https://japan-remote-guide.com)",
  };

  const getResult = await fetchSource(source, "GET", headers, timeoutMs, checkedAt);
  if (getResult.reachable) return getResult;

  const headResult = await fetchSource(source, "HEAD", headers, timeoutMs, checkedAt);
  if (headResult.reachable) return { ...headResult, note: getResult.note };
  return getResult;
}

async function fetchSource(source, method, headers, timeoutMs, checkedAt) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(source.url, {
      method,
      redirect: "follow",
      headers,
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type") || "";
    let contentText = "";
    if (method === "GET" && response.status >= 200 && response.status < 400) {
      contentText = await readableSourceText(response, contentType);
    }
    clearTimeout(timeout);
    return {
      ...source,
      checkedAt,
      method,
      status: response.status,
      reachable: response.status >= 200 && response.status < 400,
      contentType,
      contentText,
    };
  } catch (error) {
    clearTimeout(timeout);
    return {
      ...source,
      checkedAt,
      method,
      status: "error",
      reachable: false,
      contentType: "",
      contentText: "",
      note: error.message,
    };
  }
}

async function readableSourceText(response, contentType) {
  if (
    contentType &&
    !/text|html|xml|json/i.test(contentType) &&
    !/application\/octet-stream/i.test(contentType)
  ) {
    return "";
  }
  try {
    const text = await response.text();
    return cleanInline(text.replace(/<script\b[\s\S]*?<\/script>/gi, " "))
      .replace(/\s+/g, " ")
      .slice(0, 160000);
  } catch {
    return "";
  }
}

function evaluateSourceGate(article, sourceChecks) {
  const requiresFactCheck = article.highRiskTerms.length > 0;
  const claimCheck = verifyArticleClaims(article, sourceChecks);
  const hasSources = sourceChecks.length > 0;
  const officialSources = sourceChecks.filter((source) => source.official);
  const reachableSources = sourceChecks.filter((source) => source.reachable);
  const unclassifiedSources = sourceChecks.filter((source) => !source.official);
  const failedSources = sourceChecks.filter((source) => !source.reachable);
  const reasons = [];
  const warnings = [];

  if (requiresFactCheck && !hasSources) {
    reasons.push("High-risk topic without a Sources used section.");
  }
  if (requiresFactCheck && officialSources.length === 0) {
    reasons.push("High-risk topic has no recognized official or primary source.");
  }
  if (hasSources && unclassifiedSources.length > 0) {
    reasons.push(
      `Unclassified source domain(s): ${unclassifiedSources
        .map((source) => new URL(source.url).hostname)
        .join(", ")}`,
    );
  }
  if (hasSources && reachableSources.length === 0) {
    reasons.push("No source URL could be reached now.");
  }
  if (failedSources.length > 0) {
    warnings.push(
      `Source URL(s) need later recheck: ${failedSources
        .map((source) => source.url)
        .join(", ")}`,
    );
  }
  for (const reason of claimCheck.reasons) reasons.push(reason);
  for (const warning of claimCheck.warnings) warnings.push(warning);

  return {
    pass:
      (!requiresFactCheck || officialSources.length > 0) &&
      hasSources &&
      unclassifiedSources.length === 0 &&
      reachableSources.length > 0 &&
      claimCheck.pass,
    requiresFactCheck,
    officialSourceCount: officialSources.length,
    reachableSourceCount: reachableSources.length,
    checkedSourceCount: sourceChecks.length,
    claimCheck,
    reasons,
    warnings,
  };
}

function verifyArticleClaims(article, sourceChecks) {
  if (article.highRiskTerms.length === 0) {
    return {
      pass: true,
      claims: [],
      coveredCount: 0,
      coverageRate: 1,
      reasons: [],
      warnings: [],
    };
  }

  const claims = extractFactClaims(article);
  const sourceCorpus = sourceChecks
    .filter((source) => source.official && source.reachable && source.contentText)
    .map((source) => normalizeSourceText(source.contentText))
    .join(" ");
  const reasons = [];
  const warnings = [];

  if (claims.length === 0) {
    warnings.push("No high-risk claim sentence was extracted for source text comparison.");
    return {
      pass: true,
      claims: [],
      coveredCount: 0,
      coverageRate: 1,
      reasons,
      warnings,
    };
  }
  if (!sourceCorpus) {
    reasons.push("Official source text could not be fetched for claim comparison.");
    return {
      pass: false,
      claims: claims.map((claim) => ({ text: claim, covered: false, matchCount: 0 })),
      coveredCount: 0,
      coverageRate: 0,
      reasons,
      warnings,
    };
  }

  const checks = claims.map((claim) => {
    const tokens = significantTokens(claim);
    const matchCount = tokens.filter((token) => sourceCorpus.includes(token)).length;
    const needed = Math.min(3, Math.max(2, Math.ceil(tokens.length * 0.35)));
    return {
      text: claim,
      covered: tokens.length === 0 || matchCount >= needed,
      matchCount,
      tokenCount: tokens.length,
    };
  });
  const coveredCount = checks.filter((claim) => claim.covered).length;
  const coverageRate = coveredCount / checks.length;

  if (coverageRate < 0.6) {
    reasons.push(
      `Only ${coveredCount}/${checks.length} high-risk claim(s) matched fetched official source text.`,
    );
  } else if (coverageRate < 1) {
    warnings.push(
      `${checks.length - coveredCount} high-risk claim(s) need human review despite enough source coverage.`,
    );
  }

  return {
    pass: coverageRate >= 0.6,
    claims: checks,
    coveredCount,
    coverageRate,
    reasons,
    warnings,
  };
}

function extractFactClaims(article) {
  const text = article.text
    .replace(/Sources used[\s\S]*/i, " ")
    .replace(/Japan Remote Guide\. All rights reserved\.[\s\S]*/i, " ");
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => cleanInline(sentence))
    .filter((sentence) => sentence.length >= 40 && sentence.length <= 320);
  const claims = [];
  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    const hasRiskTerm = HIGH_RISK_TERMS.some((term) => lower.includes(term));
    const hasSpecificValue =
      /\b(?:jpy|yen|million|months?|days?|hours?|warning|advisory|status|insurance|tax|visa)\b/i.test(
        sentence,
      ) || /\d/.test(sentence);
    if ((hasRiskTerm || hasSpecificValue) && !claims.includes(sentence)) {
      claims.push(sentence);
    }
    if (claims.length >= 12) break;
  }
  return claims;
}

function normalizeSourceText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&[a-z0-9#]+;/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function significantTokens(value) {
  const stopwords = new Set([
    "about",
    "after",
    "also",
    "and",
    "are",
    "before",
    "can",
    "check",
    "from",
    "guide",
    "into",
    "japan",
    "local",
    "not",
    "official",
    "only",
    "plan",
    "planning",
    "remote",
    "should",
    "source",
    "sources",
    "stay",
    "that",
    "the",
    "this",
    "use",
    "with",
    "work",
    "workers",
    "you",
    "your",
  ]);
  return Array.from(
    new Set(
      normalizeSourceText(value)
        .split(" ")
        .filter((token) => token.length >= 4 || /^\d+$/.test(token))
        .filter((token) => !stopwords.has(token)),
    ),
  ).slice(0, 18);
}

function summarizeArticleChange(change, article, previousArticle) {
  const kind = change.status.startsWith("A")
    ? "new article"
    : change.status.startsWith("R")
      ? "renamed article"
      : "updated article";
  const changedHeadings = previousArticle
    ? article.h2s.filter((heading) => !previousArticle.h2s.includes(heading)).slice(0, 4)
    : article.h2s.slice(0, 4);
  const focus = changedHeadings.length > 0 ? changedHeadings : article.h2s.slice(0, 4);

  return {
    kind,
    titleChanged: previousArticle ? article.title !== previousArticle.title : true,
    descriptionChanged: previousArticle
      ? article.metaDescription !== previousArticle.metaDescription
      : true,
    h1Changed: previousArticle ? article.h1 !== previousArticle.h1 : true,
    focus,
    textDelta: previousArticle ? article.text.length - previousArticle.text.length : article.text.length,
  };
}

function buildDraft(update, context) {
  const article = update.article;
  const topic = inferTopic(article);
  const preferred = choosePreferredPattern(context.analyticsSignals, topic);
  const baseCandidates = candidateTemplates(article, topic, preferred);
  const candidates = baseCandidates.map((candidate, index) =>
    freshenCandidate(candidate, index, article, context.history),
  );
  const duplicateRefresh = candidates.some((candidate) => candidate.adjusted);
  return {
    topic,
    titleAngle: duplicateRefresh
      ? `${shortTitle(article)} - refreshed angle`
      : shortTitle(article),
    imagePrompt: buildImagePrompt(article, topic, duplicateRefresh),
    duplicateRefresh,
    suggestedTimeWindow: chooseSuggestedTimeWindow(context.history),
    candidates,
  };
}

function candidateTemplates(article, topic, preferred) {
  const ctas = preferred.ctas.length > 0 ? preferred.ctas : ctaPool(topic);
  const hashtagSets =
    preferred.hashtagSets.length > 0 ? preferred.hashtagSets : hashtagPool(topic);
  const sections = article.h2s.slice(0, 3).join(", ");
  const title = shortTitle(article);

  return [
    makeCandidate({
      angle: "source-first planning",
      body: `${title} is updated for remote workers planning Japan. Start with the practical checks, then open the official sources before you book.`,
      cta: ctas[0] || "Read the guide",
      url: article.url,
      hashtags: hashtagSets[0] || ["#Japan", "#DigitalNomad"],
    }),
    makeCandidate({
      angle: "decision checklist",
      body: `Before choosing dates, housing, or a city base in Japan, use the guide to test the decision points that can change your plan: ${sections}.`,
      cta: ctas[1] || "Use the checklist",
      url: article.url,
      hashtags: hashtagSets[1] || ["#RemoteWork", "#JapanTravel"],
    }),
    makeCandidate({
      angle: "risk-aware guidance",
      body: `A good Japan stay is not only about where to go. It is also about knowing what to verify, what to avoid assuming, and when to use official information.`,
      cta: ctas[2] || "Plan from the guide",
      url: article.url,
      hashtags: hashtagSets[2] || ["#Japan", "#RemoteWork"],
    }),
  ];
}

function makeCandidate({ angle, body, cta, url, hashtags }) {
  const uniqueTags = Array.from(new Set(hashtags)).slice(0, 3);
  return fitPost({ angle, body, cta, url, hashtags: uniqueTags });
}

function fitPost(candidate) {
  const tagText = candidate.hashtags.join(" ");
  const lines = [candidate.body, `${candidate.cta}: ${candidate.url}`, tagText].filter(Boolean);
  let text = lines.join("\n");
  if (countChars(text) <= 280) return { ...candidate, text, charCount: countChars(text) };

  const shorterBody = candidate.body.replace(/, then .*$/, ".").replace(/: .*/, ".");
  text = [shorterBody, `${candidate.cta}: ${candidate.url}`, tagText].filter(Boolean).join("\n");
  if (countChars(text) <= 280) {
    return { ...candidate, body: shorterBody, text, charCount: countChars(text) };
  }

  const oneTag = candidate.hashtags.slice(0, 1);
  text = [shorterBody, `${candidate.cta}: ${candidate.url}`, oneTag.join(" ")]
    .filter(Boolean)
    .join("\n");
  if (countChars(text) <= 280) {
    return { ...candidate, body: shorterBody, hashtags: oneTag, text, charCount: countChars(text) };
  }

  const fixed = [`${candidate.cta}: ${candidate.url}`, oneTag.join(" ")]
    .filter(Boolean)
    .join("\n");
  const remaining = 280 - countChars(fixed) - 2;
  const trimmedBody = truncateAtWord(shorterBody, remaining);
  text = [trimmedBody, fixed].filter(Boolean).join("\n");
  return { ...candidate, body: trimmedBody, hashtags: oneTag, text, charCount: countChars(text) };
}

function freshenCandidate(candidate, index, article, history) {
  const initialFreshness = assessFreshness(candidate, article, history);
  if (initialFreshness.sameArticle) {
    return { ...candidate, freshness: initialFreshness, adjusted: false };
  }
  if (
    !initialFreshness.highDuplicateRisk &&
    !initialFreshness.sameCta &&
    !initialFreshness.sameHashtagCombo
  ) {
    return { ...candidate, freshness: initialFreshness, adjusted: false };
  }

  const alternateCtas = ctaPool(inferTopic(article)).filter(
    (cta) => !history.some((item) => item.ctaKeys.includes(normalizeCta(cta))),
  );
  const alternateTags = hashtagPool(inferTopic(article)).filter((tags) => {
    const key = hashtagKey(tags);
    return !history.some((item) => item.hashtagKeys.includes(key));
  });
  const alternativeBodies = [
    `${shortTitle(article)} now has a cleaner planning path. Use it to separate what you can decide now from what still needs official confirmation.`,
    `For Japan remote-work planning, freshness matters less than reliability. This guide keeps the next decision small and source-backed.`,
    `Use this Japan guide when the plan starts to feel vague: check the route, spot the constraint, and keep official sources nearby.`,
  ];
  const adjusted = fitPost({
    angle: `${candidate.angle} - refreshed`,
    body: alternativeBodies[index % alternativeBodies.length],
    cta: alternateCtas[index % Math.max(alternateCtas.length, 1)] || candidate.cta,
    url: candidate.url,
    hashtags:
      alternateTags[index % Math.max(alternateTags.length, 1)] ||
      candidate.hashtags.slice().reverse(),
  });
  return {
    ...adjusted,
    freshness: assessFreshness(adjusted, article, history),
    adjusted: true,
  };
}

function evaluateDraftQuality(draft, update, context) {
  const checks = [];
  checks.push({
    name: "source verification",
    pass: context.sourceGate.pass,
    detail:
      context.sourceGate.reasons.join("; ") ||
      context.sourceGate.warnings.join("; ") ||
      "Sources are recognized and reachable.",
  });

  for (const [index, candidate] of draft.candidates.entries()) {
    const label = `post ${index + 1}`;
    checks.push({
      name: `${label} is 280 characters or fewer`,
      pass: candidate.charCount <= 280,
      detail: `${candidate.charCount} characters`,
    });
    checks.push({
      name: `${label} has CTA`,
      pass: /https?:\/\/\S+/.test(candidate.text) && Boolean(candidate.cta),
      detail: candidate.cta || "missing",
    });
    checks.push({
      name: `${label} has suitable hashtags`,
      pass: candidate.hashtags.length > 0 && candidate.hashtags.length <= 3,
      detail: candidate.hashtags.join(" "),
    });
    checks.push({
      name: `${label} avoids high duplicate risk`,
      pass: !candidate.freshness.highDuplicateRisk,
      detail: `max similarity ${candidate.freshness.maxSimilarity.toFixed(2)}`,
    });
    checks.push({
      name: `${label} avoids repeated CTA and hashtag combo`,
      pass: !candidate.freshness.sameCta && !candidate.freshness.sameHashtagCombo,
      detail: candidate.freshness.notes.join("; ") || "fresh",
    });
    checks.push({
      name: `${label} brand tone`,
      pass: CLICKBAIT_TERMS.every((term) => !candidate.text.toLowerCase().includes(term)),
      detail: "calm, source-aware, no clickbait terms",
    });
    checks.push({
      name: `${label} English hygiene`,
      pass: isCleanEnglish(candidate.text),
      detail: "controlled template with no repeated whitespace or broken punctuation",
    });
  }

  checks.push({
    name: "site route included",
    pass: draft.candidates.every((candidate) => candidate.text.includes(SITE_ORIGIN)),
    detail: SITE_ORIGIN,
  });
  checks.push({
    name: "latest content marker",
    pass: Boolean(update.article.lastReviewed || update.summary.kind),
    detail: update.article.lastReviewed || update.summary.kind,
  });

  return {
    pass: checks.every((check) => check.pass),
    checks,
  };
}

function isCleanEnglish(text) {
  return (
    !/\s{2,}/.test(text) &&
    !/[!?]{2,}/.test(text) &&
    !/\b([A-Za-z]+)\s+\1\b/i.test(text) &&
    !/[^\s]https?:\/\//.test(text)
  );
}

function assessFreshness(candidate, article, history) {
  const cta = normalizeCta(candidate.cta);
  const tags = hashtagKey(candidate.hashtags);
  const similarities = history.map((item) => similarity(candidate.text, item.text));
  const maxSimilarity = similarities.length > 0 ? Math.max(...similarities) : 0;
  const sameArticle = history.some(
    (item) =>
      item.text.includes(article.url) ||
      normalizeText(item.text).includes(normalizeText(article.title)),
  );
  const sameCta = history.some((item) => item.ctaKeys.includes(cta));
  const sameHashtagCombo = history.some((item) => item.hashtagKeys.includes(tags));
  const duplicateScore =
    maxSimilarity * 0.45 +
    (sameArticle ? 0.6 : 0) +
    (sameCta ? 0.15 : 0) +
    (sameHashtagCombo ? 0.15 : 0);
  const notes = [];
  if (sameArticle) notes.push("same article appeared in recent history");
  if (sameCta) notes.push("CTA resembles recent history");
  if (sameHashtagCombo) notes.push("hashtag combination repeats recent history");

  return {
    maxSimilarity,
    sameArticle,
    sameCta,
    sameHashtagCombo,
    duplicateScore,
    highDuplicateRisk: sameArticle || duplicateScore >= 0.55,
    notes,
  };
}

function loadRecentHistory() {
  const cutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
  return ["x/history", "x/archive"]
    .flatMap((dir) => listFiles(dir))
    .map((file) => {
      const text = readFileSync(file, "utf8");
      const stats = statSync(file);
      const historyDate = parseHistoryDate(text) || stats.mtime;
      return {
        file,
        text,
        postedAt: historyDate.toISOString(),
        ctaKeys: extractCtas(text),
        hashtagKeys: [hashtagKey(extractHashtags(text))].filter(Boolean),
        timeBucket: inferTimeBucket(text, historyDate),
      };
    })
    .filter((item) => new Date(item.postedAt).getTime() >= cutoffMs);
}

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(fullPath);
    return [fullPath];
  });
}

function extractCtas(text) {
  const candidates = [
    "read the guide",
    "use the checklist",
    "plan from the guide",
    "check visa fit",
    "compare cities",
    "plan weather",
    "start planning",
    "open the guide",
  ];
  const normalized = normalizeText(text);
  return candidates.filter((cta) => normalized.includes(normalizeCta(cta)));
}

function parseHistoryDate(text) {
  const raw =
    frontmatterValue(text, "postedAt") ||
    frontmatterValue(text, "scheduledAt") ||
    fieldValue(text, "postedAt") ||
    fieldValue(text, "scheduledAt") ||
    fieldValue(text, "posted");
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function frontmatterValue(text, key) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return "";
  return fieldValue(match[1], key);
}

function fieldValue(text, key) {
  const match = new RegExp(`^${key}\\s*:\\s*(.+)$`, "im").exec(text);
  return match ? match[1].trim().replace(/^["']|["']$/g, "") : "";
}

function normalizeCta(value) {
  return normalizeText(value).replace(/[^a-z0-9]+/g, " ").trim();
}

function extractHashtags(text) {
  return Array.from(text.matchAll(/#[A-Za-z][A-Za-z0-9_]*/g), (match) => match[0]);
}

function hashtagKey(tags) {
  return tags.map((tag) => tag.toLowerCase()).sort().join(" ");
}

function inferTimeBucket(text, fallbackDate) {
  const match =
    /(?:posted|scheduled|time|window|at|日時|投稿).*?(\d{1,2}):(\d{2})/i.exec(text) ||
    /T(\d{2}):(\d{2})/.exec(text);
  const hour = match ? Number(match[1]) : fallbackDate.getHours();
  if (hour >= 6 && hour < 11) return "morning";
  if (hour >= 11 && hour < 16) return "midday";
  if (hour >= 16 && hour < 21) return "evening";
  return "late";
}

function chooseSuggestedTimeWindow(history) {
  const counts = new Map(TIME_WINDOWS.map((window) => [window.key, 0]));
  for (const item of history) {
    counts.set(item.timeBucket, (counts.get(item.timeBucket) || 0) + 1);
  }
  const [key] = Array.from(counts.entries()).sort((a, b) => a[1] - b[1])[0];
  return TIME_WINDOWS.find((window) => window.key === key)?.label || TIME_WINDOWS[0].label;
}

function loadAnalyticsSignals() {
  const analyticsFiles = listFiles("x/analytics").filter((file) => /\.(json|md|txt)$/i.test(file));
  const scored = analyticsFiles
    .map((file) => {
      const text = readFileSync(file, "utf8");
      const engagementRate = numericField(text, "engagementRate");
      const clickRate = numericField(text, "clickRate");
      const followRate = numericField(text, "followRate");
      if ([engagementRate, clickRate, followRate].every((value) => value === null)) return null;
      return {
        file,
        score: (engagementRate || 0) * 0.6 + (clickRate || 0) * 0.3 + (followRate || 0) * 0.1,
        hashtags: extractHashtags(text),
        ctas: extractCtas(text),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, 10);
}

function numericField(text, field) {
  const match = new RegExp(`${field}\\s*[:=]\\s*([0-9.]+)`, "i").exec(text);
  return match ? Number(match[1]) : null;
}

function choosePreferredPattern(signals, topic) {
  const ctas = [];
  const hashtagSets = [];
  for (const signal of signals) {
    for (const cta of signal.ctas) {
      if (!ctas.includes(cta)) ctas.push(cta);
    }
    if (signal.hashtags.length > 0) hashtagSets.push(signal.hashtags.slice(0, 3));
  }
  return {
    ctas: ctas.length > 0 ? ctas : ctaPool(topic),
    hashtagSets: hashtagSets.length > 0 ? hashtagSets : hashtagPool(topic),
  };
}

function inferTopic(article) {
  const text = `${article.slug} ${article.title} ${article.h1}`.toLowerCase();
  if (text.includes("visa") || text.includes("nomad status")) return "visa";
  if (text.includes("weather") || text.includes("typhoon")) return "weather";
  if (text.includes("city") || text.includes("cities")) return "cities";
  return "planning";
}

function ctaPool(topic) {
  const pools = {
    visa: ["Check visa fit", "Read the visa guide", "Start with official checks"],
    weather: ["Plan weather", "Use the weather checklist", "Check the planning guide"],
    cities: ["Compare cities", "Choose your base", "Use the city guide"],
    planning: ["Read the guide", "Start planning", "Use the checklist"],
  };
  return pools[topic] || pools.planning;
}

function hashtagPool(topic) {
  const pools = {
    visa: [
      ["#DigitalNomadVisa", "#Japan"],
      ["#JapanTravel", "#RemoteWork"],
      ["#DigitalNomad", "#Japan"],
    ],
    weather: [
      ["#JapanTravel", "#RemoteWork"],
      ["#Japan", "#TravelPlanning"],
      ["#DigitalNomad", "#Japan"],
    ],
    cities: [
      ["#DigitalNomad", "#Japan"],
      ["#RemoteWork", "#JapanTravel"],
      ["#Japan", "#CityGuide"],
    ],
    planning: [
      ["#DigitalNomad", "#Japan"],
      ["#RemoteWork", "#JapanTravel"],
      ["#Japan", "#TravelPlanning"],
    ],
  };
  return pools[topic] || pools.planning;
}

function buildImagePrompt(article, topic, duplicateRefresh = false) {
  const prompts = {
    visa:
      "Create a clean editorial image for Japan Remote Guide: a remote worker at a desk with a laptop, passport, calendar, and source checklist, subtle Japan travel context, calm neutral colors, no official seals, no fake visa document text, trustworthy planning mood.",
    weather:
      "Create a clean editorial image for Japan Remote Guide: a laptop work setup beside a window with Japanese city rain outside, weather icons on a planning notebook, calm practical mood, no alarmist disaster imagery.",
    cities:
      "Create a clean editorial image for Japan Remote Guide: a practical map-style desk scene comparing Tokyo, Osaka, Fukuoka, Kyoto, Sapporo, and Okinawa for remote work, laptop and transit card, refined editorial style.",
    planning:
      "Create a clean editorial image for Japan Remote Guide: Japan travel planning desk with laptop, checklist, transit card, and city notes, trustworthy source-aware style, no stock-photo exaggeration.",
  };
  const prompt = prompts[topic] || prompts.planning;
  if (!duplicateRefresh) return prompt;
  return `${prompt} Use a clearly different composition from the last 30 days: change the visual angle, foreground object, and CTA mood while keeping the same calm, trustworthy brand style.`;
}

function renderDraft(update, draft, qualityGate, sourceRecordPath, sourceGate) {
  const article = update.article;
  return [
    "---",
    `status: post_candidate`,
    `createdAt: ${startedAt.toISOString()}`,
    `articlePath: ${article.path}`,
    `articleUrl: ${article.url}`,
    `sourceRecord: ${normalizePath(sourceRecordPath)}`,
    `suggestedTimeWindowJST: ${draft.suggestedTimeWindow}`,
    "---",
    "",
    `# X Drafts: ${article.title}`,
    "",
    "## Update Summary",
    "",
    ...renderSummaryBullets(update),
    "",
    "## Source Verification",
    "",
    `- Source record: ${normalizePath(sourceRecordPath)}`,
    `- High-risk terms detected: ${article.highRiskTerms.join(", ") || "none"}`,
    `- Claim coverage: ${contextPercent(sourceGate.claimCheck?.coverageRate)}`,
    `- Last reviewed marker: ${article.lastReviewed || "not found"}`,
    "",
    "## Duplication Review",
    "",
    `- Past 30-day files checked: ${loadRecentHistory().length}`,
    `- Suggested posting window: ${draft.suggestedTimeWindow}`,
    `- Title angle: ${draft.titleAngle}`,
    `- Duplicate refresh applied: ${draft.duplicateRefresh ? "yes" : "no"}`,
    "- Candidates below passed duplicate, CTA, hashtag, source, length, and brand checks.",
    "",
    "## Image Prompt",
    "",
    draft.imagePrompt,
    "",
    "## Post Options",
    "",
    ...draft.candidates.flatMap((candidate, index) => [
      `### Option ${index + 1}: ${candidate.angle}`,
      "",
      "```text",
      candidate.text,
      "```",
      "",
      `- Characters: ${candidate.charCount}`,
      `- CTA: ${candidate.cta}`,
      `- Hashtags: ${candidate.hashtags.join(" ")}`,
      `- Freshness adjustment: ${candidate.adjusted ? "yes" : "no"}`,
      `- Max similarity with recent history: ${candidate.freshness.maxSimilarity.toFixed(2)}`,
      "",
    ]),
    "## Quality Checklist",
    "",
    ...qualityGate.checks.map(
      (check) => `- [${check.pass ? "x" : " "}] ${check.name}: ${check.detail}`,
    ),
    "",
  ].join("\n");
}

function renderSummaryBullets(update) {
  const article = update.article;
  const summary = update.summary;
  return [
    `- Change type: ${summary.kind}`,
    `- Page: ${article.path}`,
    `- Title: ${article.title}`,
    `- Main promise: ${article.h1}`,
    `- Updated focus: ${summary.focus.join("; ") || "No new section focus detected."}`,
    `- Approximate text delta: ${summary.textDelta >= 0 ? "+" : ""}${summary.textDelta} characters`,
  ];
}

function writeSourceRecord(update, sourceChecks, sourceGate) {
  const article = update.article;
  const filePath = path.join(
    "x/sources",
    `${nowId}-${slugify(article.slug)}-sources.md`,
  );
  if (dryRun) return filePath;

  writeFile(
    filePath,
    [
      "---",
      `createdAt: ${startedAt.toISOString()}`,
      `articlePath: ${article.path}`,
      `articleUrl: ${article.url}`,
      "---",
      "",
      `# Source Record: ${article.title}`,
      "",
      `- Reference date: ${formatDate(startedAt)}`,
      `- Check time: ${startedAt.toISOString()}`,
      `- Last reviewed marker on page: ${article.lastReviewed || "not found"}`,
      `- Claim coverage: ${contextPercent(sourceGate.claimCheck?.coverageRate)}`,
      "",
      "| URL | Provider | Priority | Checked At | Status |",
      "| --- | --- | --- | --- | --- |",
      ...sourceChecks.map(
        (source) =>
          `| ${source.url} | ${escapeTable(source.provider)} | ${source.priority} | ${source.checkedAt} | ${source.reachable ? `OK ${source.status}` : `HOLD ${source.status}${source.note ? ` (${escapeTable(source.note)})` : ""}`} |`,
      ),
      "",
      "## High-Risk Claim Comparison",
      "",
      ...(sourceGate.claimCheck?.claims?.length
        ? [
            "| Claim | Official Source Text Match | Token Matches |",
            "| --- | --- | --- |",
            ...sourceGate.claimCheck.claims.map(
              (claim) =>
                `| ${escapeTable(truncateAtWord(claim.text, 140))} | ${claim.covered ? "yes" : "needs review"} | ${claim.matchCount}/${claim.tokenCount} |`,
            ),
          ]
        : ["- No high-risk claim comparison was required."]),
      "",
    ].join("\n"),
  );
  return filePath;
}

function writeRunLog({
  startedAt,
  sinceCommit,
  untilCommit,
  changedFiles,
  skippedFiles,
  articleUpdates,
  results,
  dryRun,
}) {
  const filePath = path.join("x/logs", `${nowId}-article-monitor.md`);
  if (dryRun) return filePath;

  writeFile(
    filePath,
    [
      "---",
      `createdAt: ${startedAt.toISOString()}`,
      `sinceCommit: ${sinceCommit || "initial"}`,
      `untilCommit: ${untilCommit}`,
      "---",
      "",
      "# Article Monitor Log",
      "",
      "## Run",
      "",
      `- Started: ${startedAt.toISOString()}`,
      `- Since: ${sinceCommit || "initial"}`,
      `- Until: ${untilCommit}`,
      `- Dry run: ${dryRun ? "yes" : "no"}`,
      "",
      "## Changed HTML Files",
      "",
      ...(changedFiles.length
        ? changedFiles.map((file) => `- ${file.status}: ${file.path}`)
        : ["- No changed HTML files detected."]),
      "",
      "## Evaluated Articles",
      "",
      ...(articleUpdates.length
        ? articleUpdates.flatMap((update) => renderSummaryBullets(update))
        : ["- No article updates required draft generation."]),
      "",
      "## Skipped Files",
      "",
      ...(skippedFiles.length
        ? skippedFiles.map((file) => `- ${file.path}: ${file.reason}`)
        : ["- None"]),
      "",
      "## Results",
      "",
      ...(results.length
        ? results.map((result) => {
            const failed = result.qualityGate.checks
              .filter((check) => !check.pass)
              .map((check) => check.name)
              .join(", ");
            return `- ${result.article}: ${result.status}${result.draftPath ? ` (${normalizePath(result.draftPath)})` : ""}${failed ? `; failed checks: ${failed}` : ""}`;
          })
        : ["- No draft or hold decisions."]),
      "",
    ].join("\n"),
  );
  return filePath;
}

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function slugify(value) {
  return String(value || "article")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function shortTitle(article) {
  return article.title
    .replace(/\s*\|\s*Japan Remote Guide/i, "")
    .replace(/\s*-\s*Japan Remote Guide/i, "")
    .trim();
}

function truncateAtWord(value, maxLength) {
  const text = String(value || "");
  if (countChars(text) <= maxLength) return text;
  const clipped = Array.from(text).slice(0, Math.max(0, maxLength - 3)).join("");
  return `${clipped.replace(/\s+\S*$/, "")}...`;
}

function countChars(value) {
  return Array.from(String(value || "")).length;
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/#[a-z0-9_]+/gi, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function similarity(a, b) {
  const left = trigrams(normalizeText(a));
  const right = trigrams(normalizeText(b));
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const item of left) {
    if (right.has(item)) intersection += 1;
  }
  return intersection / (left.size + right.size - intersection);
}

function trigrams(text) {
  const compact = text.replace(/\s+/g, " ");
  if (compact.length < 3) return new Set(compact ? [compact] : []);
  const grams = new Set();
  for (let index = 0; index <= compact.length - 3; index += 1) {
    grams.add(compact.slice(index, index + 3));
  }
  return grams;
}

function toFileStamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function contextPercent(value) {
  if (!Number.isFinite(value)) return "not required";
  return `${Math.round(value * 100)}%`;
}

function escapeTable(value) {
  return String(value || "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
