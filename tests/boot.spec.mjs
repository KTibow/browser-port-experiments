import { test, expect } from "@playwright/test";
import { bootAndWaitForScreen } from "./helpers.mjs";

// KolibriOS is tiny and boots to a graphical desktop in seconds. This proves
// the whole stack (WASM CPU + image load + canvas rendering). It also gates the
// deploy. Resilience: kolibri.img is SELF-HOSTED (dist/mirror/), so this gate
// does NOT depend on copy.sh being up — a copy.sh outage can no longer block a
// deploy or break the flagship demo. We assert the self-hosted source was used.
test("@smoke KolibriOS boots to a graphical desktop (self-hosted)", async ({ page }) => {
  const info = await bootAndWaitForScreen(page, "kolibrios", {
    timeoutMs: 90_000,
    minWidth: 800,
    minColors: 25,
  });
  expect(info.width).toBeGreaterThanOrEqual(800);
  expect(info.colors).toBeGreaterThanOrEqual(25);
  await expect(page.locator("#status")).toHaveText("Running");
  // Prove the boot used our own origin's mirror, not copy.sh.
  expect(await page.evaluate(() => window.__usedMirror)).toBe(true);
});

// Regression guard for copy.sh streaming (the source for every image we cannot
// self-host). Forcing ?cdn= bypasses the mirror and streams kolibri.img from
// copy.sh with the no-Referer hotlink workaround. NOT in @smoke: a copy.sh
// outage should not block deploys (that's the whole point of the mirror); this
// runs in the full / scheduled verify suite instead.
test("KolibriOS still boots streaming from copy.sh @cdn", async ({ page }) => {
  const info = await bootAndWaitForScreen(page, "kolibrios", {
    timeoutMs: 120_000,
    minWidth: 800,
    minColors: 25,
    query: "&cdn=https://i.copy.sh/",
  });
  expect(info.width).toBeGreaterThanOrEqual(800);
  expect(info.colors).toBeGreaterThanOrEqual(25);
  await expect(page.locator("#status")).toHaveText("Running");
  // With ?cdn= forced, the mirror must be bypassed.
  expect(await page.evaluate(() => window.__usedMirror)).toBe(false);
});

// State-image OSes resume a booted desktop. These prove real, feature-complete
// browser engines are available (IE/Trident, WebKit) and that state restore works
// with the vendored wasm.
const stateOses = [
  // Windows 95: classic teal desktop (1024x768) restores in ~2s; it is mostly one
  // color plus a handful of icons (IE, Control Panel, System...), so ~12 colors.
  { id: "windows95", minWidth: 800, minColors: 9 }, // Internet Explorer (Trident)
  { id: "windows98", minWidth: 600 },   // Internet Explorer (Trident)
  { id: "windows2000", minWidth: 600 }, // Internet Explorer 5 (Trident)
  { id: "windowsme", minWidth: 600 },   // Internet Explorer (Trident)
  { id: "haiku", minWidth: 600 },       // WebPositive (WebKit)
  { id: "reactos", minWidth: 600 },     // IE-compatible shell (virtio NIC)
  { id: "serenityos", minWidth: 600, minColors: 20 }, // Ladybird (LibWeb); streams zstd parts
  // 9front (Plan 9 fork): restores to the rio desktop (1024x768) with a term%
  // rc shell. The desktop is mostly grey + a white window, so it has few colors
  // (~20); we assert on the resolution + a low color floor.
  { id: "9front", minWidth: 800, minColors: 10 }, // Mothra / NetSurf (Plan 9)
];

for (const os of stateOses) {
  test(`${os.id} restores from saved state @state`, async ({ page }, testInfo) => {
    const info = await bootAndWaitForScreen(page, os.id, {
      timeoutMs: 220_000,
      minWidth: os.minWidth,
      minColors: os.minColors || 8,
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

// Redox OS (a modern Unix-like OS written from scratch in Rust around a
// microkernel, with its own Orbital GUI desktop; the demo image ships NetSurf).
// Its saved state restores to the Orbital LOGIN screen (user `user`, empty
// password); the runner's `autokeys` presses Enter to AUTO-LOGIN, then the
// Orbital desktop loads its JWST wallpaper (thousands of colors). We assert on
// the rich wallpaper desktop (>=800 colors) so the test proves we got PAST the
// login prompt to the real desktop where NetSurf lives — not just the login
// screen (which is ~124 colors). The wallpaper JPEG decodes slowly under
// software emulation (~80s observed), so this gets a generous budget. The state
// was saved with the ne2k NIC default, so we must restore with ne2k (virtio
// corrupts the device state and triple-faults).
test("redox restores from state and auto-logs-in to the Orbital desktop @state", async ({ page }, testInfo) => {
  test.setTimeout(320_000);
  const info = await bootAndWaitForScreen(page, "redox", {
    timeoutMs: 290_000,
    minWidth: 1000,
    minColors: 800,
  });
  expect(info.width).toBeGreaterThanOrEqual(1000);
  expect(info.colors).toBeGreaterThanOrEqual(800);
  await expect(page.locator("#status")).toHaveText("Running");
  await testInfo.attach("redox.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  if (process.env.SHOT_DIR) {
    await page.screenshot({ path: `${process.env.SHOT_DIR}/shot-redox.png` });
  }
});

// SliTaz is a live boot (the ISO is attached as a hard disk). It auto-boots
// through its language menu and brings up a full graphical desktop (1280x720)
// with Midori (WebKitGTK), and DHCP over Wisp comes up on its own. We assert on
// the rich desktop (hundreds of colors), not the early boot/menu screens.
test("slitaz boots its live image into the graphical desktop @livecd", async ({ page }, testInfo) => {
  const info = await bootAndWaitForScreen(page, "slitaz", {
    timeoutMs: 220_000,
    minWidth: 1000,   // X11 switches the canvas to 1280x720
    minColors: 200,   // full Openbox desktop + wallpaper, not the boot menu
  });
  expect(info.width).toBeGreaterThanOrEqual(1000);
  expect(info.colors).toBeGreaterThanOrEqual(200);
  await expect(page.locator("#status")).toHaveText("Running");
  await testInfo.attach("slitaz.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  if (process.env.SHOT_DIR) {
    await page.screenshot({ path: `${process.env.SHOT_DIR}/shot-slitaz.png` });
  }
});

// Android-x86 4.4 boots from scratch through GRUB (640x480, colorful splash) and
// a long kernel/zygote/bootanimation phase (800x600, very few colors) before the
// launcher appears (800x600, dozens of colors). Software x86 emulation makes this
// slow (~4-5 min) and it streams ~250 MB, so this is a dedicated @slow test with
// a generous timeout. We require the 800x600 launcher with enough colors to rule
// out the low-color boot animation.
test("android4 boots to the Android launcher @slow", async ({ page }, testInfo) => {
  test.setTimeout(440_000);
  const info = await bootAndWaitForScreen(page, "android4", {
    timeoutMs: 410_000,
    minWidth: 780,   // launcher is 800x600 (GRUB menu is 640x480)
    minColors: 45,   // launcher home screen; boot animation stays well below this
  });
  expect(info.width).toBeGreaterThanOrEqual(780);
  expect(info.colors).toBeGreaterThanOrEqual(45);
  await expect(page.locator("#status")).toHaveText("Running");
  await testInfo.attach("android4.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  if (process.env.SHOT_DIR) {
    await page.screenshot({ path: `${process.env.SHOT_DIR}/shot-android4.png` });
  }
});

// Damn Small Linux is a live CD: no saved state. Its Syslinux bootloader waits
// at a `boot:` prompt, so the registry uses `autokeys` to press Enter; then it
// loads X11. The full fluxbox desktop has far more colors than the 16-color
// boot splash, which is what we assert on.
test("dsl boots its live CD into the X11 desktop @cdrom", async ({ page }, testInfo) => {
  const info = await bootAndWaitForScreen(page, "dsl", {
    timeoutMs: 220_000,
    minWidth: 1000,   // X11 switches the canvas to 1024x768
    minColors: 120,   // full desktop (wallpaper + conky + icons), not the splash
  });
  expect(info.width).toBeGreaterThanOrEqual(1000);
  expect(info.colors).toBeGreaterThanOrEqual(120);
  await expect(page.locator("#status")).toHaveText("Running");
  await testInfo.attach("dsl.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  if (process.env.SHOT_DIR) {
    await page.screenshot({ path: `${process.env.SHOT_DIR}/shot-dsl.png` });
  }
});
