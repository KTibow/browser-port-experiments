#!/usr/bin/env node
// Build the static site into dist/.
// - copies the v86 runtime (libv86.mjs + v86.wasm) out of node_modules
// - copies vendored BIOS files and the source site
// - generates the root index from browsers.json
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatDownload } from "../src/download-format.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const vendorDir = path.join(dist, "vendor");

async function rmrf(p) {
  await fs.rm(p, { recursive: true, force: true });
}

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyDir(s, d);
    else await fs.copyFile(s, d);
  }
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function main() {
  await rmrf(dist);
  await fs.mkdir(dist, { recursive: true });

  // 1. Copy source site (html/css/js) verbatim.
  await copyDir(path.join(root, "src"), dist);

  // 2. Copy the registry so the runner can fetch it at runtime.
  await fs.copyFile(path.join(root, "browsers.json"), path.join(dist, "browsers.json"));

  // 3. Vendor the v86 runtime out of node_modules.
  await fs.mkdir(vendorDir, { recursive: true });
  const v86Build = path.join(root, "node_modules", "v86", "build");
  if (!(await exists(v86Build))) {
    throw new Error(
      "node_modules/v86 not found. Run `npm install` before building."
    );
  }
  await fs.copyFile(path.join(v86Build, "libv86.mjs"), path.join(vendorDir, "libv86.mjs"));
  await fs.copyFile(path.join(v86Build, "v86.wasm"), path.join(vendorDir, "v86.wasm"));
  if (await exists(path.join(v86Build, "v86-fallback.wasm"))) {
    await fs.copyFile(path.join(v86Build, "v86-fallback.wasm"), path.join(vendorDir, "v86-fallback.wasm"));
  }

  // 4. Copy vendored BIOS files.
  await copyDir(path.join(root, "vendor", "bios"), path.join(vendorDir, "bios"));

  // 4b. Copy the self-hosted image mirror (resilience: small critical images are
  // served from our own origin so a copy.sh outage can't break the flagship,
  // the @smoke deploy gate, or the @network proof). See mirror/README.md.
  const mirrorSrc = path.join(root, "mirror");
  if (await exists(mirrorSrc)) {
    await copyDir(mirrorSrc, path.join(dist, "mirror"));
  }

  // 5. Generate index.html from the template + registry.
  const registry = JSON.parse(await fs.readFile(path.join(root, "browsers.json"), "utf8"));
  const template = await fs.readFile(path.join(root, "src", "index.html"), "utf8");
  const cards = registry.browsers.map(cardHtml).join("\n");
  const html = template.replace("<!--CARDS-->", cards);
  await fs.writeFile(path.join(dist, "index.html"), html);

  // 6. Jekyll-off marker (so GitHub Pages serves files starting with _ and vendor as-is).
  await fs.writeFile(path.join(dist, ".nojekyll"), "");

  // Report.
  const count = registry.browsers.length;
  const mirrored = (await exists(path.join(dist, "mirror")))
    ? (await fs.readdir(path.join(dist, "mirror"))).filter((f) => f !== "README.md")
    : [];
  console.log(`Built dist/ with ${count} browser(s); mirror: ${mirrored.join(", ") || "(none)"}.`);
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const TESTED_LABELS = {
  network: { text: "verified \u00b7 networked", cls: "ok" },
  boots: { text: "verified \u00b7 boots", cls: "ok" },
  pending: { text: "unverified", cls: "pending" },
  broken: { text: "needs work", cls: "broken" },
};

function cardHtml(b) {
  const tag = TESTED_LABELS[b.tested] || TESTED_LABELS.pending;
  const hi = b.highlight ? " card--highlight" : "";
  const dl = formatDownload(b);
  const dlHtml = dl
    ? `<span class="card__dl" title="${esc(dl.title)}">${esc(dl.short)}</span>`
    : "";
  return `      <a class="card${hi}" href="run.html?os=${encodeURIComponent(b.id)}">
        <div class="card__top">
          <span class="card__name">${esc(b.name)}</span>
          <span class="badge badge--${tag.cls}">${esc(tag.text)}</span>
        </div>
        <div class="card__engine">${esc(b.engine)} <span class="card__era">${esc(b.era)}</span></div>
        <p class="card__blurb">${esc(b.blurb)}</p>
        <div class="card__foot">
          <span class="card__go">Launch &rarr;</span>
          ${dlHtml}
        </div>
      </a>`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
