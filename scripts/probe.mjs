#!/usr/bin/env node
// Boot an OS in a headless Chromium, wait for the canvas to render a real
// screen, and save a screenshot to /tmp. Used to manually verify guests boot.
//
//   node scripts/probe.mjs <osId> [timeoutMs]
//
// Requires the dev server running (npm run serve) and a built dist/.
import { chromium } from "@playwright/test";
import { promises as fs } from "node:fs";

const osId = process.argv[2];
const timeoutMs = Number(process.argv[3] || 200_000);
if (!osId) {
  console.error("usage: node scripts/probe.mjs <osId> [timeoutMs]");
  process.exit(2);
}

const base = process.env.BASE_URL || "http://localhost:8000";
const shotDir = process.env.SHOT_DIR || "/tmp/probe-shots";
await fs.mkdir(shotDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  const t = m.text();
  if (/error|fail|exception|panic/i.test(t)) console.log(`  [console] ${t}`);
});

console.log(`Booting ${osId} (timeout ${timeoutMs}ms)…`);
await page.goto(`${base}/run.html?os=${encodeURIComponent(osId)}`, { waitUntil: "domcontentloaded" });

const start = Date.now();
let last = null;
let done = false;
while (Date.now() - start < timeoutMs) {
  last = await page.evaluate(() => {
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
      width: c?.width || 0,
      height: c?.height || 0,
      colors,
      status: document.getElementById("status")?.textContent || "",
      net: document.getElementById("net")?.textContent || "",
    };
  });
  const elapsed = Math.floor((Date.now() - start) / 1000);
  process.stdout.write(`\r  t=${elapsed}s  ${last.width}x${last.height} colors=${last.colors} status="${last.status}"   `);
  if (last.width >= 320 && last.colors >= 8) { done = true; break; }
  await page.waitForTimeout(2500);
}
console.log("");

const shotPath = `${shotDir}/shot-${osId}.png`;
await page.screenshot({ path: shotPath });
console.log(`Screenshot: ${shotPath}`);
console.log(`Final: ${JSON.stringify(last)}`);
console.log(`Page errors: ${errors.length ? errors.join("; ") : "none"}`);
console.log(done ? "RESULT: rendered a screen ✅" : "RESULT: did NOT render ❌");

await browser.close();
process.exit(done ? 0 : 1);
