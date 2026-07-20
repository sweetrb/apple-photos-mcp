// Sync every plugin-manifest version to package.json's version.
// With --check: write nothing — exit 0 silently when every manifest already
// matches, exit 1 listing the mismatched files otherwise (used by CI).
import fs from "node:fs";
import path from "node:path";

const check = process.argv.includes("--check");
const root = process.cwd();
const packageJson = readJson("package.json");
const version = packageJson.version;
const mismatches = [];

updateJson(".claude-plugin/plugin.json", (data) => {
  data.version = version;
});

updateJson("codex/.codex-plugin/plugin.json", (data) => {
  data.version = version;
});

updateJson(".claude-plugin/marketplace.json", (data) => {
  data.version = version;
  for (const plugin of data.plugins ?? []) {
    if (plugin.name === "apple-photos") {
      plugin.version = version;
    }
  }
});

updateJson(".agents/plugins/marketplace.json", (data) => {
  for (const plugin of data.plugins ?? []) {
    if (plugin.name === "apple-photos") {
      plugin.version = version;
    }
  }
});

updateJson(".antigravity-plugin/plugin.json", (data) => {
  data.version = version;
});

updateJson(".antigravity-plugin/marketplace.json", (data) => {
  for (const plugin of data.plugins ?? []) {
    if (plugin.name === "apple-photos") {
      plugin.version = version;
    }
  }
});

if (check && mismatches.length > 0) {
  console.error(`Plugin manifests out of sync with package.json (${version}):`);
  for (const file of mismatches) {
    console.error(`  ${file}`);
  }
  console.error("Run: node scripts/sync-plugin-version.mjs");
  process.exit(1);
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function updateJson(relativePath, update) {
  const fullPath = path.join(root, relativePath);
  const before = fs.readFileSync(fullPath, "utf8");
  const data = JSON.parse(before);
  update(data);
  const after = `${JSON.stringify(data, null, 2)}\n`;
  if (check) {
    if (after !== before) {
      mismatches.push(relativePath);
    }
    return;
  }
  fs.writeFileSync(fullPath, after);
}
