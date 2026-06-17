import { test, expect } from "@playwright/test";
import { bootAndWaitForScreen } from "./helpers.mjs";

// KolibriOS is tiny and boots to a graphical desktop in seconds. This proves
// the whole stack (WASM CPU + on-demand image streaming + canvas rendering).
test("@smoke KolibriOS boots to a graphical desktop", async ({ page }) => {
  const info = await bootAndWaitForScreen(page, "kolibrios", {
    timeoutMs: 90_000,
    minWidth: 800,
    minColors: 25,
  });
  expect(info.width).toBeGreaterThanOrEqual(800);
  expect(info.colors).toBeGreaterThanOrEqual(25);
  await expect(page.locator("#status")).toHaveText("Running");
});

// State-image OSes resume a booted desktop. These prove real, feature-complete
// browser engines are available (IE/Trident, WebKit) and that state restore works
// with the vendored wasm.
const stateOses = [
  { id: "windows98", minWidth: 600 },   // Internet Explorer (Trident)
  { id: "windows2000", minWidth: 600 }, // Internet Explorer 5 (Trident)
  { id: "haiku", minWidth: 600 },       // WebPositive (WebKit)
];

for (const os of stateOses) {
  test(`${os.id} restores from saved state @state`, async ({ page }, testInfo) => {
    const info = await bootAndWaitForScreen(page, os.id, {
      timeoutMs: 220_000,
      minWidth: os.minWidth,
      minColors: 8,
    });
    expect(info.width).toBeGreaterThanOrEqual(os.minWidth);
    await expect(page.locator("#status")).toHaveText("Running");
    // Attach a screenshot to the report for visual confirmation.
    await testInfo.attach(`${os.id}.png`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    if (process.env.SHOT_DIR) {
      await page.screenshot({ path: `${process.env.SHOT_DIR}/shot-${os.id}.png` });
    }
  });
}
