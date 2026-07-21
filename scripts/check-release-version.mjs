import { readFileSync } from "node:fs";

const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) {
  throw new Error(`Expected a stable release tag such as v0.2.2, received ${tag ?? "nothing"}.`);
}

const expectedVersion = tag.slice(1);
const manifests = [
  ["workspace", "package.json"],
  ["web", "apps/web/package.json"],
  ["Core", "packages/core/package.json"],
  ["CLI", "packages/cli/package.json"],
].map(([label, path]) => [label, path, JSON.parse(readFileSync(path, "utf8"))]);

for (const [label, path, manifest] of manifests) {
  if (manifest.version !== expectedVersion) {
    throw new Error(`${label} version in ${path} is ${manifest.version}; expected ${expectedVersion}.`);
  }
}

const [, , workspace] = manifests[0];
const [, , web] = manifests[1];
const [, , core] = manifests[2];
const [, , cli] = manifests[3];

if (workspace.name !== "@mmd2pptx/workspace" || workspace.private !== true) {
  throw new Error("The workspace root must remain the private @mmd2pptx/workspace package.");
}
if (web.name !== "@mmd2pptx/web" || web.private !== true) {
  throw new Error("The web application must remain the private @mmd2pptx/web package.");
}
if (core.name !== "@mmd2pptx/core" || core.private === true) {
  throw new Error("Core must remain the public @mmd2pptx/core package.");
}
if (cli.name !== "mmd2pptx" || cli.private === true) {
  throw new Error("The CLI must remain the public mmd2pptx package.");
}
if (cli.dependencies?.["@mmd2pptx/core"] !== "workspace:*") {
  throw new Error("The CLI must depend on the matching workspace Core release.");
}

console.log(`Release ${tag} matches all workspace package manifests.`);
