import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

// UX polish (Task 6): the loading progress bar and the Wisp relay picker.
// These are deterministic and offline (the progress-bar test never boots a VM;
// the relay test only reads/changes the picker), so they're fast and reliable.

// The progress bar is driven by v86's `download-progress` events. We test the
// wiring deterministically via the window.__onDownloadProgress hook so the
// assertion doesn't depend on network timing. We use a non-existent os id so the
// runner never starts an emulator (which would otherwise hide the bar on boot).
test("loading progress bar fills from download events @ux", async ({ page }) => {
  await page.goto("/run.html?os=__no_such_os__", { waitUntil: "domcontentloaded" });

  // Initially hidden.
  await expect(page.locator("#progress")).toBeHidden();

  // A known-total event -> determinate bar at ~50% with a MB label.
  await page.evaluate(() =>
    window.__onDownloadProgress({ file_name: "windows98/0-262144.img", loaded: 5_000_000, total: 10_000_000 })
  );
  await expect(page.locator("#progress")).toBeVisible();
  const label = page.locator("#progress_label");
  await expect(label).toContainText("50%");
  await expect(label).toContainText("MB");
  const width = await page.locator("#progress_bar").evaluate((el) => parseFloat(el.style.width));
  expect(width).toBeGreaterThan(40);
  expect(width).toBeLessThan(60);

  // Progress to 100%.
  await page.evaluate(() =>
    window.__onDownloadProgress({ file_name: "windows98/0-262144.img", loaded: 10_000_000, total: 10_000_000 })
  );
  await expect(label).toContainText("100%");

  // An unknown-total event -> indeterminate sweep.
  await page.evaluate(() =>
    window.__onDownloadProgress({ file_name: "blob.bin", loaded: 1_234_567, total: 0 })
  );
  await expect(page.locator("#progress_bar")).toHaveClass(/is-indeterminate/);
});

test("relay picker lists verified relays and defaults to anura.pro @ux", async ({ page }) => {
  const registry = JSON.parse(await readFile(new URL("../browsers.json", import.meta.url)));
  await page.goto("/run.html?os=kolibrios", { waitUntil: "domcontentloaded" });

  const sel = page.locator("#relay");
  await expect(sel).toBeVisible();

  // Every registry relay is an option, plus a Custom… entry.
  const values = await sel.locator("option").evaluateAll((opts) => opts.map((o) => o.value));
  for (const r of registry.relays) expect(values).toContain(r.url);
  expect(values).toContain("__custom__");

  // The default (registry.relay) is selected and shown in the status bar.
  await expect(sel).toHaveValue(registry.relay);
  await expect(page.locator("#net")).toContainText("anura.pro");
});

test("switching the relay reloads with ?relay_url= and applies it @ux", async ({ page }) => {
  await page.goto("/run.html?os=kolibrios", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#relay")).toBeVisible();

  const alt = "wisps://wisp.mercurywork.shop/";
  await page.locator("#relay").selectOption(alt);

  // The change handler navigates to the same page with the new relay.
  await page.waitForURL(/relay_url=/, { timeout: 10_000 });
  expect(page.url()).toContain(encodeURIComponent(alt));

  // After reload, the runner picks up the relay: picker selected + status bar.
  await expect(page.locator("#relay")).toHaveValue(alt);
  await expect(page.locator("#net")).toContainText("wisp.mercurywork.shop");
});
