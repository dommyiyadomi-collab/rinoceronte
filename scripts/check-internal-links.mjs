import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const publicDir = path.resolve("public");
const htmlFiles = walk(publicDir).filter((file) => file.endsWith(".html"));
const problems = [];

for (const file of htmlFiles) {
  const html = readFileSync(file, "utf8");
  const refs = collectRefs(html);

  for (const ref of refs) {
    const target = normalizeInternalRef(ref);
    if (!target) continue;

    const targetPath = path.join(publicDir, target);
    if (!existsSync(targetPath)) {
      problems.push(`${path.relative(process.cwd(), file)} -> ${ref}`);
    }
  }
}

if (problems.length > 0) {
  console.error("Missing internal links or assets:");
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}

console.log(`Checked ${htmlFiles.length} HTML files.`);

function walk(dir) {
  return readdirSync(dir)
    .flatMap((name) => {
      const fullPath = path.join(dir, name);
      return statSync(fullPath).isDirectory() ? walk(fullPath) : fullPath;
    });
}

function collectRefs(html) {
  const refs = [];
  const pattern = /\b(?:href|src)=["']([^"']+)["']/gi;
  let match;

  while ((match = pattern.exec(html))) {
    refs.push(match[1]);
  }

  return refs;
}

function normalizeInternalRef(ref) {
  if (
    ref.startsWith("http://") ||
    ref.startsWith("https://") ||
    ref.startsWith("mailto:") ||
    ref.startsWith("tel:") ||
    ref.startsWith("#")
  ) {
    return null;
  }

  const withoutHash = ref.split("#")[0];
  const withoutQuery = withoutHash.split("?")[0];
  if (!withoutQuery || withoutQuery === "/") return "index.html";

  const clean = withoutQuery.startsWith("/")
    ? withoutQuery.slice(1)
    : withoutQuery;

  if (clean.endsWith("/")) return `${clean}index.html`;
  return clean;
}
