import { test, expect } from "@playwright/test";
import { bootAndWaitForScreen } from "./helpers.mjs";

// Mobile / touch input (Task 6 remainder). v86 already turns a finger drag into
// a relative mouse-delta (trackpad-style cursor movement) and already forwards
// keys from a `.phone_keyboard` element to the guest, but it has NO tap-to-click
// and our page never exposed a keyboard target. The runner now adds:
//   - tap            -> left click   (mouse-click [true,false,false]/[false...])
//   - long-press     -> right click  (mouse-click [false,false,true]/[false...])
//   - a "Keyboard" toggle that focuses #phonekbd (.phone_keyboard) so the soft
//     keyboard pops and v86 forwards keystrokes to the guest.
// All run in a touch-enabled browser context.
test.use({ hasTouch: true });

// Fast, no-boot UI checks: the touch hint, the phone-keyboard element, and the
// keyboard toggle's focus behaviour. (We navigate to a real os so the runner
// wires its controls, but we don't wait for the VM to finish booting.)
test("touch UI: hint, phone keyboard, and keyboard toggle @touch", async ({ page }) => {
  await page.goto("/run.html?os=kolibrios", { waitUntil: "domcontentloaded" });

  // On a coarse-pointer device the runner shows touch usage in the hint bar.
  await expect(page.locator("#hint")).toContainText("Touch:");
  await expect(page.locator("#hint")).toContainText("tap = click");

  // The on-screen keyboard target exists and carries the class v86 recognises.
  await expect(page.locator("#phonekbd")).toHaveClass(/phone_keyboard/);

  // The toggle focuses the phone keyboard (which raises the soft keyboard on a
  // real device) and reflects the active state; toggling again blurs it.
  const toggle = page.locator("#kbdtoggle");
  await toggle.click();
  expect(await page.evaluate(() => document.activeElement?.id)).toBe("phonekbd");
  await expect(toggle).toHaveClass(/is-active/);
  await toggle.click();
  expect(await page.evaluate(() => document.activeElement?.id)).not.toBe("phonekbd");
  await expect(toggle).not.toHaveClass(/is-active/);
});

// End-to-end on a booted guest: prove a tap and a long-press actually reach
// v86's input bus as mouse clicks, and that the phone keyboard forwards a key.
// KolibriOS is the fast, self-hosted flagship.
test("tap = left click, long-press = right click, phone keyboard types @touch", async ({ page }, testInfo) => {
  await bootAndWaitForScreen(page, "kolibrios", {
    timeoutMs: 90_000,
    minWidth: 800,
    minColors: 25,
  });

  // Hook v86's input bus so we can observe what the touch/keyboard handlers send.
  // The runner sends clicks via emulator.bus.send("mouse-click", ...) and v86
  // forwards keys via "keyboard-code"; both go through the same bus instance.
  await page.evaluate(() => {
    window.__busLog = [];
    const e = window.__emulator;
    const orig = e.bus.send.bind(e.bus);
    e.bus.send = function (name, data) {
      if (name === "mouse-click" || name === "keyboard-code" || name === "mouse-delta") {
        window.__busLog.push([name, Array.isArray(data) ? data.slice() : data]);
      }
      return orig(name, data);
    };
  });

  const canvas = page.locator("#screen_container canvas");
  const box = await canvas.boundingBox();
  const cx = Math.round(box.x + box.width / 2);
  const cy = Math.round(box.y + box.height / 2);

  // --- DRAG -> moves the guest cursor (v86 turns a finger drag into mouse-delta;
  //     this confirms the trackpad-move path is live in our page) ---
  await page.evaluate(() => { window.__busLog.length = 0; });
  await dispatchTouch(page, "touchstart", cx, cy);
  await dispatchTouch(page, "touchmove", cx + 40, cy + 30);
  await dispatchTouch(page, "touchmove", cx + 90, cy + 70);
  await dispatchTouch(page, "touchend", cx + 90, cy + 70);
  const deltas = await page.evaluate(() =>
    window.__busLog.filter((x) => x[0] === "mouse-delta").map((x) => x[1])
  );
  expect(deltas.length).toBeGreaterThan(0); // v86 emitted relative movement
  // A drag must NOT also fire a click (it's a move, not a tap).
  expect(await page.evaluate(() =>
    window.__busLog.some((x) => x[0] === "mouse-click")
  )).toBe(false);

  // --- TAP -> left click ---
  await page.evaluate(() => { window.__busLog.length = 0; window.__lastTouchClick = null; });
  await page.touchscreen.tap(cx, cy);
  await page.waitForTimeout(200); // allow the deferred button-release
  expect(await page.evaluate(() => window.__lastTouchClick)).toBe("left");
  const tapClicks = await page.evaluate(() =>
    window.__busLog.filter((x) => x[0] === "mouse-click").map((x) => x[1])
  );
  // press [true,false,false] then release [false,false,false]
  expect(tapClicks).toEqual(
    expect.arrayContaining([[true, false, false], [false, false, false]])
  );
  expect(tapClicks[0]).toEqual([true, false, false]);

  // --- LONG-PRESS -> right click ---
  await page.evaluate(() => { window.__busLog.length = 0; window.__lastTouchClick = null; });
  await dispatchTouch(page, "touchstart", cx, cy);
  await page.waitForTimeout(650); // > LONGPRESS_MS (500)
  expect(await page.evaluate(() => window.__lastTouchClick)).toBe("right");
  await dispatchTouch(page, "touchend", cx, cy);
  const lpClicks = await page.evaluate(() =>
    window.__busLog.filter((x) => x[0] === "mouse-click").map((x) => x[1])
  );
  expect(lpClicks).toEqual(
    expect.arrayContaining([[false, false, true]])
  );
  expect(lpClicks[0]).toEqual([false, false, true]); // right button down first

  // --- PHONE KEYBOARD -> forwards a key to the guest ---
  await page.evaluate(() => { window.__busLog.length = 0; });
  await page.locator("#phonekbd").focus();
  expect(await page.evaluate(() => document.activeElement?.id)).toBe("phonekbd");
  await page.keyboard.press("KeyA");
  await page.waitForTimeout(100);
  const codes = await page.evaluate(() =>
    window.__busLog.filter((x) => x[0] === "keyboard-code").map((x) => x[1])
  );
  // KeyA -> scancode 30 (down); v86 only forwards because of the phone_keyboard class.
  expect(codes).toContain(30);

  await testInfo.attach("kolibrios-touch.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});

// Dispatch a real TouchEvent on the guest canvas (used for the long-press, which
// page.touchscreen can't express). Requires a touch-enabled context.
async function dispatchTouch(page, type, x, y) {
  await page.evaluate(({ type, x, y }) => {
    const container = document.querySelector("#screen_container");
    const target = container.querySelector("canvas") || container;
    const touch = new Touch({ identifier: 1, target, clientX: x, clientY: y, pageX: x, pageY: y });
    const empty = type === "touchend";
    target.dispatchEvent(new TouchEvent(type, {
      bubbles: true,
      cancelable: true,
      touches: empty ? [] : [touch],
      targetTouches: empty ? [] : [touch],
      changedTouches: [touch],
    }));
  }, { type, x, y });
}
