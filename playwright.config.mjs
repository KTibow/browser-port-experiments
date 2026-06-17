import { defineConfig, devices } from "@playwright/test";

// The site streams OS images from copy.sh and connects to anura.pro (Wisp),
// so boot/network tests are inherently slow and depend on external services.
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:8000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], channel: undefined } },
  ],
  webServer: {
    command: "node scripts/build.mjs && node scripts/serve.mjs",
    url: "http://localhost:8000/",
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
  },
});
