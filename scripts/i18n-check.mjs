// Prüft die Übersetzung: Jeder t("…")-Text braucht einen Eintrag in src/i18n/en.json,
// und deutsche Texte außerhalb von t() fallen auf. `npm run i18n` (mit --fix: fehlende
// Einträge als "TODO" anlegen und alphabetisch sortieren — es wird nichts gelöscht).
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../src/", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const dictPath = join(root, "i18n", "en.json");
const dict = JSON.parse(readFileSync(dictPath, "utf8"));
const fix = process.argv.includes("--fix");

const files = [];
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx?|ts)$/.test(f)) files.push(p);
  }
};
walk(root);

const used = new Set();
const suspicious = [];
// t("…"), t('…'), t(`…`).
const callRe = /\bt\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g;
const germanRe = /["'`]([^"'`\n]*(?:[äöüÄÖÜß]|\b(?:und|oder|nicht|keine?|Einstellungen|Datei|Dateien|Woche|Heute|Ziehen|Öffnen|Schließen|Löschen)\b)[^"'`\n]*)["'`]/g;

for (const file of files) {
  if (file.includes(`${join("i18n", "")}`) || file.includes(`${join("dev", "")}`)) continue;
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(callRe)) used.add(m[2].replace(/\\(["'`\\])/g, "$1"));
  text.split("\n").forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, "").trim();
    if (code.startsWith("*") || code.startsWith("/*")) return;
    for (const m of code.matchAll(germanRe)) {
      const s = m[1];
      if (dict[s] !== undefined || used.has(s)) continue;
      if (/^[\w.:/-]+$/.test(s) && !/[äöüß]/.test(s)) continue;
      suspicious.push(`${file.slice(root.length)}:${i + 1}  ${s}`);
    }
  });
}

const missing = [...used].filter((k) => dict[k] === undefined).sort();
const unused = Object.keys(dict).filter((k) => !used.has(k)).sort();

console.log(`Fehlend in en.json (${missing.length}):\n  ${missing.join("\n  ")}`);
console.log(`\nDeutsch ohne t() (${suspicious.length}):\n  ${suspicious.join("\n  ")}`);
// Meist indirekt genutzt (Listen mit Labels, die erst beim Rendern durch t() gehen).
if (process.argv.includes("--unused")) console.log(`\nNicht direkt per t() gefunden (${unused.length}):\n  ${unused.join("\n  ")}`);

if (fix) {
  const next = {};
  for (const k of [...Object.keys(dict), ...missing].sort((a, b) => a.localeCompare(b, "de")))
    next[k] = dict[k] ?? "TODO";
  writeFileSync(dictPath, JSON.stringify(next, null, 1) + "\n");
  console.log("\nen.json aktualisiert.");
}
process.exitCode = missing.length > 0 ? 1 : 0;
