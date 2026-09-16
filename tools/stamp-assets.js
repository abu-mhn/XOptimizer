#!/usr/bin/env node
// tools/stamp-assets.js — keep the ?v= cache-busting tokens honest.
//
// Every page references its scripts and stylesheet with a ?v= token so a
// returning visitor doesn't get a stale copy. Those tokens used to be one
// shared date string, bumped by hand across 16 files. That fails in the two
// ways you'd expect: forget to bump it and everyone keeps the old code
// (which cost two debugging rounds), or bump it for a one-line change and
// every visitor re-downloads the 470KB stylesheet for nothing.
//
// So the token is now a CONTENT HASH of the file it points at. It changes
// exactly when that file changes, never otherwise, and it cannot be
// forgotten — running this is idempotent, and --check fails loudly if it
// hasn't been run.
//
//   node tools/stamp-assets.js           rewrite every token to match content
//   node tools/stamp-assets.js --check   exit 1 if any token is stale
//
// Paths resolve from docs/ because every sub-page carries <base href="../">,
// so "js/core.js" means docs/js/core.js on a page at docs/tournament/.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const DOCS = path.join(ROOT, "docs");
const CHECK = process.argv.includes("--check");

// src="..." / href="..." carrying a ?v= token. Group 2 is the file path,
// group 3 the current token.
const REF = /((?:src|href)=")([^"?]+)\?v=([^"]*)(")/g;

function hashOf(file) {
  return crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex").slice(0, 8);
}

function htmlFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) htmlFiles(full, out);
    else if (entry.name.endsWith(".html")) out.push(full);
  }
  return out;
}

const hashes = new Map();   // asset path -> hash, so each file is read once
const missing = new Set();
let stale = 0, touched = 0, refs = 0;
const changedFiles = [];

for (const page of htmlFiles(DOCS)) {
  const before = fs.readFileSync(page, "utf8");
  let pageStale = 0;

  const after = before.replace(REF, (whole, pre, assetPath, token, post) => {
    // Leave anything absolute or protocol-relative alone — not ours to stamp.
    if (/^(?:[a-z]+:)?\/\//i.test(assetPath)) return whole;
    refs++;
    const abs = path.join(DOCS, assetPath.replace(/^\.\//, ""));
    if (!hashes.has(abs)) {
      if (!fs.existsSync(abs)) { missing.add(assetPath); hashes.set(abs, null); }
      else hashes.set(abs, hashOf(abs));
    }
    const want = hashes.get(abs);
    if (want === null) return whole;          // unresolved — never guess
    if (want === token) return whole;
    stale++; pageStale++;
    return pre + assetPath + "?v=" + want + post;
  });

  if (after !== before) {
    changedFiles.push([path.relative(ROOT, page), pageStale]);
    if (!CHECK) { fs.writeFileSync(page, after); touched++; }
  }
}

const assetCount = [...hashes.values()].filter(v => v !== null).length;
console.log(`${refs} references across ${htmlFiles(DOCS).length} pages -> ${assetCount} assets`);

if (missing.size) {
  console.log("\nreferenced but not found (left untouched):");
  for (const m of missing) console.log("   " + m);
}

if (!stale) {
  console.log("\nAll tokens match their file contents. Nothing to do.");
  process.exit(0);
}

console.log(`\n${stale} stale token${stale === 1 ? "" : "s"} in ${changedFiles.length} page${changedFiles.length === 1 ? "" : "s"}:`);
for (const [file, n] of changedFiles) console.log(`   ${String(n).padStart(3)}  ${file}`);

if (CHECK) {
  console.log("\n--check: tokens are stale. Run `node tools/stamp-assets.js` before deploying.");
  process.exit(1);
}
console.log(`\nStamped ${touched} page${touched === 1 ? "" : "s"}.`);
