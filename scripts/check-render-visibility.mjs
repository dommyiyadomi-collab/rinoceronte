import { readFileSync } from "node:fs";

const css = readFileSync("public/style.css", "utf8");
const citiesHtml = readFileSync("public/cities.html", "utf8");
const mainJs = readFileSync("public/main.js", "utf8");
const problems = [];
const revealRulePattern = /\.reveal-ready\s*\{([\s\S]*?)\}/g;
let match;

while ((match = revealRulePattern.exec(css))) {
  const declarations = match[1];
  if (/\bopacity\s*:\s*0(?:\.0+)?\s*(?:;|$)/.test(declarations)) {
    problems.push(
      "The base .reveal-ready rule must not set opacity: 0. Full-page renderers do not scroll, so below-fold city guide content can stay blank.",
    );
  }
}

const cityProfiles = citiesHtml.match(/<article class="city-profile">[\s\S]*?<\/article>/g) ?? [];
for (const profile of cityProfiles) {
  const image = profile.match(/<img\b[^>]*>/)?.[0] ?? "";
  if (/\bloading=["']lazy["']/.test(image)) {
    problems.push(
      "City profile images must not use loading=\"lazy\". Full-page renderers do not scroll, so lazy profile photos can remain blank.",
    );
    break;
  }
}

if (!/\.city-profile img/.test(mainJs) || !/\.decode\s*\(/.test(mainJs)) {
  problems.push(
    "City profile images should be decoded early so full-page renderers do not capture blank offscreen photo placeholders.",
  );
}

if (problems.length > 0) {
  console.error("Render visibility check failed:");
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}

console.log("Render visibility check passed.");
