import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("@smoke landing page lists every registered browser", async ({ page }) => {
  const registry = JSON.parse(await readFile(new URL("../browsers.json", import.meta.url)));
  await page.goto("/");

  await expect(page.locator("h1")).toHaveText(/Browser Port Experiments/);

  const cards = page.locator("a.card");
  await expect(cards).toHaveCount(registry.browsers.length);

  // Every browser has a card whose link points at the runner with the right id.
  for (const b of registry.browsers) {
    const card = page.locator(`a.card[href="run.html?os=${b.id}"]`);
    await expect(card).toBeVisible();
    await expect(card).toContainText(b.name);
  }
});

test("@smoke runner page loads its module and shows the Wisp relay", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/run.html?os=kolibrios", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#title")).toHaveText("KolibriOS", { timeout: 10_000 });
  await expect(page.locator("#net")).toContainText("anura.pro");
  expect(errors, "no uncaught page errors").toEqual([]);
});
