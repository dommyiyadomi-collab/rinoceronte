#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const WINDOWS = [
  { key: "24h", ms: 24 * 60 * 60 * 1000, label: "24 hours" },
  { key: "7d", ms: 7 * 24 * 60 * 60 * 1000, label: "7 days" },
  { key: "30d", ms: 30 * 24 * 60 * 60 * 1000, label: "30 days" },
];
const REQUIRED_METRICS = [
  "impressions",
  "engagements",
  "likes",
  "reposts",
  "replies",
  "bookmarks",
  "linkClicks",
  "profileClicks",
  "follows",
];
const now = new Date();
const nowId = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

for (const dir of [
  "x/history",
  "x/archive",
  "x/analytics",
  "x/analytics/raw",
  "x/analytics/pending",
  "x/reports",
]) {
  mkdirSync(dir, { recursive: true });
}

const posts = loadPostedHistory();
const results = [];

for (const post of posts) {
  for (const window of WINDOWS) {
    if (now.getTime() - post.postedAt.getTime() < window.ms) continue;
    if (analysisExists(post, window)) continue;

    const metrics = readMetrics(post, window);
    if (!metrics) {
      const pendingPath = writePending(post, window);
      results.push({ post: post.slug, window: window.key, status: "pending", path: pendingPath });
      continue;
    }

    const analysis = analyze(post, window, metrics);
    const analyticsPath = writeAnalysis(post, window, metrics, analysis);
    const reportPath = writeReport(post, window, metrics, analysis, analyticsPath);
    results.push({
      post: post.slug,
      window: window.key,
      status: "analyzed",
      path: analyticsPath,
      reportPath,
    });
  }
}

console.log(
  [
    `X analytics checked ${posts.length} posted item(s).`,
    `${results.filter((result) => result.status === "analyzed").length} analysis file(s) created.`,
    `${results.filter((result) => result.status === "pending").length} pending metric request(s) created.`,
  ].join("\n"),
);

function loadPostedHistory() {
  return ["x/history", "x/archive"]
    .flatMap((dir) => listFiles(dir))
    .map(parsePost)
    .filter(Boolean);
}

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(fullPath) : [fullPath];
  });
}

function parsePost(file) {
  const text = readFileSync(file, "utf8");
  const postedAtRaw =
    frontmatterValue(text, "postedAt") ||
    fieldValue(text, "postedAt") ||
    fieldValue(text, "posted");
  const postId =
    frontmatterValue(text, "postId") ||
    fieldValue(text, "postId") ||
    path.basename(file, path.extname(file));
  if (!postedAtRaw) return null;
  const postedAt = new Date(postedAtRaw);
  if (Number.isNaN(postedAt.getTime())) return null;
  return {
    file,
    postId,
    slug: slugify(postId),
    postedAt,
    text,
    hashtags: Array.from(text.matchAll(/#[A-Za-z][A-Za-z0-9_]*/g), (match) => match[0]),
    cta: extractCta(text),
    timeBucket: inferTimeBucket(postedAt),
  };
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

function extractCta(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /https?:\/\/\S+/.test(line)) || "";
}

function inferTimeBucket(date) {
  const hour = date.getHours();
  if (hour >= 6 && hour < 11) return "morning";
  if (hour >= 11 && hour < 16) return "midday";
  if (hour >= 16 && hour < 21) return "evening";
  return "late";
}

function analysisExists(post, window) {
  const prefix = `${post.slug}-${window.key}`;
  return listFiles("x/analytics").some((file) => path.basename(file).includes(prefix));
}

function readMetrics(post, window) {
  const candidates = [
    path.join("x/analytics/raw", `${post.slug}-${window.key}.json`),
    path.join("x/analytics/raw", `${post.postId}-${window.key}.json`),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (REQUIRED_METRICS.every((metric) => Number.isFinite(Number(parsed[metric])))) {
        return Object.fromEntries(
          REQUIRED_METRICS.map((metric) => [metric, Number(parsed[metric])]),
        );
      }
    } catch {
      return null;
    }
  }
  return null;
}

function analyze(post, window, metrics) {
  const engagementRate = ratio(metrics.engagements, metrics.impressions);
  const clickRate = ratio(metrics.linkClicks, metrics.impressions);
  const followRate = ratio(metrics.follows, metrics.impressions);
  const bookmarkRate = ratio(metrics.bookmarks, metrics.impressions);
  const strengths = [];
  const improvements = [];

  if (clickRate >= 0.01) strengths.push("The post moved readers toward the site.");
  else improvements.push("Make the site reason more specific before the link.");

  if (engagementRate >= 0.03) strengths.push("The topic or angle earned meaningful interaction.");
  else improvements.push("Test a sharper planning problem or more concrete audience segment.");

  if (bookmarkRate >= 0.005) strengths.push("The post appears save-worthy for later planning.");
  else improvements.push("Add a clearer checklist, constraint, or decision point.");

  if (followRate >= 0.002) strengths.push("The post supported account trust and audience fit.");
  else improvements.push("Reinforce the source-aware Japan remote-work positioning.");

  return {
    window: window.key,
    engagementRate,
    clickRate,
    followRate,
    bookmarkRate,
    strengths,
    improvements,
    nextPost:
      clickRate >= 0.01
        ? "Repeat the practical guide angle with a fresh CTA and different hashtag mix."
        : "Try a more specific pain point, then send readers to one guide page.",
    timeRecommendation: recommendTime(post.timeBucket, engagementRate, clickRate),
    hashtagRecommendation: recommendHashtags(post.hashtags, engagementRate),
    ctaRecommendation: recommendCta(post.cta, clickRate),
    imageRecommendation:
      metrics.bookmarks > metrics.likes
        ? "Use a clean checklist or planning-board image that signals save value."
        : "Use a clearer editorial image that shows the exact planning situation.",
  };
}

function ratio(numerator, denominator) {
  if (!denominator) return 0;
  return Number((numerator / denominator).toFixed(4));
}

function recommendTime(bucket, engagementRate, clickRate) {
  if (engagementRate >= 0.03 || clickRate >= 0.01) {
    return `Keep testing the ${bucket} posting window.`;
  }
  return `Reduce reliance on the ${bucket} posting window and test another slot.`;
}

function recommendHashtags(hashtags, engagementRate) {
  if (engagementRate >= 0.03) {
    return `Keep one proven tag from ${hashtags.join(" ") || "the current set"} and rotate the rest.`;
  }
  return "Use fewer broad tags and test one topic-specific tag tied to the guide.";
}

function recommendCta(cta, clickRate) {
  if (clickRate >= 0.01) return `Keep the CTA pattern but vary the wording: ${cta || "current CTA"}.`;
  return "Make the CTA name the reader's next decision, not only the page type.";
}

function writePending(post, window) {
  const filePath = path.join("x/analytics/pending", `${post.slug}-${window.key}.md`);
  if (existsSync(filePath)) return filePath;
  writeFileSync(
    filePath,
    [
      "---",
      `createdAt: ${now.toISOString()}`,
      `postId: ${post.postId}`,
      `postedAt: ${post.postedAt.toISOString()}`,
      `window: ${window.key}`,
      "---",
      "",
      `# Pending X Metrics: ${post.postId} (${window.label})`,
      "",
      "Save raw metrics to:",
      "",
      `x/analytics/raw/${post.slug}-${window.key}.json`,
      "",
      "Required JSON fields:",
      "",
      "```json",
      JSON.stringify(
        Object.fromEntries(REQUIRED_METRICS.map((metric) => [metric, 0])),
        null,
        2,
      ),
      "```",
      "",
    ].join("\n"),
    "utf8",
  );
  return filePath;
}

function writeAnalysis(post, window, metrics, analysis) {
  const filePath = path.join("x/analytics", `${nowId}-${post.slug}-${window.key}.md`);
  writeFileSync(
    filePath,
    [
      "---",
      `createdAt: ${now.toISOString()}`,
      `postId: ${post.postId}`,
      `postedAt: ${post.postedAt.toISOString()}`,
      `window: ${window.key}`,
      `engagementRate: ${analysis.engagementRate}`,
      `clickRate: ${analysis.clickRate}`,
      `followRate: ${analysis.followRate}`,
      "---",
      "",
      `# X Analytics: ${post.postId} (${window.label})`,
      "",
      "## Metrics",
      "",
      ...REQUIRED_METRICS.map((metric) => `- ${metric}: ${metrics[metric]}`),
      `- engagementRate: ${analysis.engagementRate}`,
      `- clickRate: ${analysis.clickRate}`,
      `- followRate: ${analysis.followRate}`,
      "",
      "## Readout",
      "",
      ...analysis.strengths.map((item) => `- Success: ${item}`),
      ...analysis.improvements.map((item) => `- Improve: ${item}`),
      "",
    ].join("\n"),
    "utf8",
  );
  return filePath;
}

function writeReport(post, window, metrics, analysis, analyticsPath) {
  const filePath = path.join("x/reports", `${nowId}-${post.slug}-${window.key}-report.md`);
  writeFileSync(
    filePath,
    [
      "---",
      `createdAt: ${now.toISOString()}`,
      `postId: ${post.postId}`,
      `analytics: ${analyticsPath.replace(/\\/g, "/")}`,
      `window: ${window.key}`,
      "---",
      "",
      `# Improvement Report: ${post.postId} (${window.label})`,
      "",
      "## Success Factors",
      "",
      ...(analysis.strengths.length ? analysis.strengths.map((item) => `- ${item}`) : ["- No strong signal yet."]),
      "",
      "## Improvements",
      "",
      ...(analysis.improvements.length ? analysis.improvements.map((item) => `- ${item}`) : ["- Keep testing this pattern with fresh wording."]),
      "",
      "## Next Test",
      "",
      `- Next post: ${analysis.nextPost}`,
      `- Time: ${analysis.timeRecommendation}`,
      `- Hashtags: ${analysis.hashtagRecommendation}`,
      `- CTA: ${analysis.ctaRecommendation}`,
      `- Image design: ${analysis.imageRecommendation}`,
      "",
      "## Raw Metrics Snapshot",
      "",
      ...REQUIRED_METRICS.map((metric) => `- ${metric}: ${metrics[metric]}`),
      "",
    ].join("\n"),
    "utf8",
  );
  return filePath;
}

function slugify(value) {
  return String(value || "post")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
