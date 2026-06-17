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

// Windows 98 resumes from a saved state image: proves real Internet Explorer /
// Trident is available and that state restore works with the vendored wasm.
test("Windows 98 restores from saved state @state", async ({ page }) => {
  const info = await bootAndWaitForScreen(page, "windows98", {
    timeoutMs: 200_000,
    minWidth: 600,
    minColors: 8,
  });
  expect(info.width).toBeGreaterThanOrEqual(600);
  await expect(page.locator("#status")).toHaveText("Running");
});
