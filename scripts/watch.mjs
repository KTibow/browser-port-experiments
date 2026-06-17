#!/usr/bin/env node
// Boot an OS in headless Chromium and log a timeline of canvas size / colors /
// status, saving a screenshot at intervals. Unlike probe.mjs (which stops at the
// first non-trivial frame), this watches the whole boot — handy for slow guests
// that pass through boot menus and splash screens before the real desktop
// (e.g. SliTaz ~135s, Android 4.4 ~4-5min).
//
//   node scripts/watch.mjs <osId> [totalMs] [shotEveryMs]
//
// Requires `npm run serve` (or the Playwright webServer) on http://localhost:8000.
import { chromium } from "@playwright/test";
import { promises as fs } from "node:fs";

const osId = process.argv[2];
const totalMs = Number(process.argv[3] || 180000);
const shotEvery = Number(process.argv[4] || 20000);
if (!osId) {
  console.error("usage: node scripts/watch.mjs <osId> [totalMs] [shotEveryMs]");
  process.exit(2);
}
const base = process.env.BASE_URL || "http://localhost:8000";
const shotDir = process.env.SHOT_DIR || "/tmp/probe-shots";
await fs.mkdir(shotDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(`${base}/run.html?os=${encodeURIComponent(osId)}`, { waitUntil: "domcontentloaded" });
const start = Date.now();
let nextShot = 0;
let shotN = 0;
while (Date.now() - start < totalMs) {
  const info = await page.evaluate(() => {
    const c = document.querySelector("#screen_container canvas");
    let colors = 0;
    if (c && c.width && c.height) {
      try {
        const ctx = c.getContext("2d", { willReadFrequently: true });
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        const seen = new Set();
        for (let i = 0; i < d.length; i += 4 * 97) seen.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
        colors = seen.size;
      } catch {}
    }
    return {
      width: c?.width || 0, height: c?.height || 0, colors,
      status: document.getElementById("status")?.textContent || "",
      net: document.getElementById("net")?.textContent || "",
    };
  });
  const t = Math.floor((Date.now() - start) / 1000);
  console.log(`t=${t}s ${info.width}x${info.height} colors=${info.colors} status="${info.status}" net="${info.net}"`);
  if (Date.now() - start >= nextShot) {
    const p = `${shotDir}/watch-${osId}-${String(shotN).padStart(2, "0")}.png`;
    await page.screenshot({ path: p });
    console.log("  shot:", p);
    nextShot += shotEvery; shotN++;
  }
  await page.waitForTimeout(5000);
}
const p = `${shotDir}/watch-${osId}-final.png`;
await page.screenshot({ path: p });
console.log("final shot:", p);
console.log("errors:", errors.length ? errors.join("; ") : "none");
await browser.close();
