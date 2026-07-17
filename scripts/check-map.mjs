import { readFileSync } from "node:fs";

const html = readFileSync("public/index.html", "utf8");
const css = readFileSync("public/style.css", "utf8");
const problems = [];

const mapMatch = html.match(
  /<div class="japan-map-panel"[\s\S]*?<\/div>\s*<\/div>/,
);
const mapHtml = mapMatch?.[0] ?? "";

if (!mapHtml) {
  problems.push("The homepage is missing .japan-map-panel.");
}

if (!mapHtml.includes("<svg") || !mapHtml.includes('class="japan-map"')) {
  problems.push("The Japan map panel must include an inline .japan-map SVG.");
}

if (mapHtml.includes("map-line") || css.includes(".map-line")) {
  problems.push("The broken decorative .map-line map must be removed.");
}

for (const label of ["Hokkaido", "Honshu", "Shikoku", "Kyushu", "Okinawa"]) {
  if (!mapHtml.includes(label)) {
    problems.push(`The map SVG is missing ${label}.`);
  }
}

for (const city of ["Sapporo", "Tokyo", "Osaka", "Kyoto", "Fukuoka", "Okinawa"]) {
  if (!mapHtml.includes(`>${city}<`)) {
    problems.push(`The map is missing the ${city} pin label.`);
  }
}

if (problems.length > 0) {
  console.error("Japan map check failed:");
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}

console.log("Japan map check passed.");
