import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const readJSON = async (file) => JSON.parse(await readFile(file, "utf8"));

const manifest = await readJSON("manifest.json");
const pkg = await readJSON("package.json");
const versions = await readJSON("versions.json");

assert.match(
  manifest.version,
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/,
  "manifest.version must be x.y.z"
);
assert.equal(pkg.version, manifest.version, "package.json version must match manifest.json");
assert.equal(
  versions[manifest.version],
  manifest.minAppVersion,
  "versions.json must map the current version to minAppVersion"
);
assert.equal(manifest.id, "slipstream", "manifest.id must stay slipstream");
assert.equal(manifest.isDesktopOnly, true, "SlipStream must remain desktop-only");
assert.ok(
  typeof manifest.description === "string" &&
    manifest.description.length > 0 &&
    manifest.description.length <= 250 &&
    manifest.description.endsWith("."),
  "manifest.description must be a sentence of at most 250 chars"
);

for (const file of ["main.js", "manifest.json", "styles.css"]) {
  const data = await readFile(file);
  assert.ok(data.length > 0, `${file} must exist and be non-empty`);
}

const requested = process.argv.indexOf("--version");
if (requested !== -1) {
  const version = process.argv[requested + 1];
  assert.equal(version, manifest.version, "Tag version must match manifest.version");
}

console.log(
  `Release checks passed: SlipStream ${manifest.version}, Obsidian ${manifest.minAppVersion}+`
);
