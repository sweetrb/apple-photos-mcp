import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const packageJson = readJson("package.json");
const version = packageJson.version;

updateJson(".claude-plugin/plugin.json", (data) => {
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

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function updateJson(relativePath, update) {
  const fullPath = path.join(root, relativePath);
  const data = readJson(relativePath);
  update(data);
  fs.writeFileSync(fullPath, `${JSON.stringify(data, null, 2)}\n`);
}
