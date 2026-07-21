import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const marker = "mmd2pptx synthetic fixture";
const tracked = [
  execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }),
  execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    encoding: "utf8",
  }),
].join("").split("\0").filter(Boolean);

const publicExamples = tracked.filter((path) =>
  path === "apps/web/src/example.ts" ||
  path.includes("/test/fixtures/") ||
  path.includes("/tests/fixtures/")
);

const textExtensions = new Set([
  ".css", ".html", ".js", ".json", ".md", ".mjs", ".mmd", ".svg",
  ".ts", ".txt", ".yaml", ".yml",
]);

const secretPatterns = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ["AWS access key", /\bAKIA[A-Z0-9]{16}\b/],
  ["npm token", /\bnpm_[A-Za-z0-9]{20,}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ["bearer token", /\bBearer\s+[A-Za-z0-9._~-]{20,}\b/i],
];

const failures = [];
for (const path of publicExamples) {
  const extension = path.slice(path.lastIndexOf("."));
  if (!textExtensions.has(extension)) continue;
  const content = readFileSync(path, "utf8");
  if (!content.toLowerCase().includes(marker)) {
    failures.push(`${path}: missing \`${marker}\` marker`);
  }

  for (const [label, pattern] of secretPatterns) {
    if (pattern.test(content)) failures.push(`${path}: possible ${label}`);
  }

  for (const email of content.matchAll(/[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/gi)) {
    const domain = email[1]?.toLowerCase();
    if (domain && !["example.com", "example.org", "example.net"].includes(domain)) {
      failures.push(`${path}: non-example email address`);
    }
  }

  for (const address of content.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
    if (!isDocumentationAddress(address[0])) {
      failures.push(`${path}: non-documentation IPv4 address`);
    }
  }
}

if (failures.length > 0) {
  console.error("Public example policy check failed:\n" + failures.map((item) => `- ${item}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Checked ${publicExamples.length} synthetic public example file(s).`);
}

function isDocumentationAddress(value) {
  const [a, b, c, d] = value.split(".").map(Number);
  if ([a, b, c, d].some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return a === 127 || a === 10 || (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113);
}
