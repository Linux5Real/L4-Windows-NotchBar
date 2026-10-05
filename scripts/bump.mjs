// Sets the app version everywhere it lives: `npm run bump 1.2.0`.
// Commit and push afterwards; the release workflow builds and publishes it.
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("Usage: npm run bump <major.minor.patch>");
  process.exit(1);
}

const edit = (path, pattern, replacement) => {
  const text = readFileSync(path, "utf8");
  if (!pattern.test(text)) throw new Error(`No version found in ${path}`);
  writeFileSync(path, text.replace(pattern, replacement));
};

edit("package.json", /("version":\s*")[^"]+(")/, `$1${version}$2`);
edit("src-tauri/tauri.conf.json", /("version":\s*")[^"]+(")/, `$1${version}$2`);
edit("src-tauri/Cargo.toml", /^(version\s*=\s*")[^"]+(")/m, `$1${version}$2`);
edit("src-tauri/Cargo.lock", /(name = "notch"\r?\nversion = ")[^"]+(")/, `$1${version}$2`);

console.log(`Version set to ${version}. Commit and push to publish the release.`);
