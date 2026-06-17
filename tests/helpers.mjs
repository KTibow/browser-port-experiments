// Shared helpers for booting v86 guests in tests.

// Boot an OS via the runner page and wait until the canvas renders a real
// screen (resized beyond the default 300x150 and showing several colors).
// Returns { width, height, colors }.
export async function bootAndWaitForScreen(page, osId, {
  timeoutMs = 180_000,
  minColors = 8,
  minWidth = 320,
  query = "", // extra query string, e.g. "&cdn=https://i.copy.sh/"
} = {}) {
  await page.goto(`/run.html?os=${encodeURIComponent(osId)}${query}`, { waitUntil: "domcontentloaded" });

  const start = Date.now();
  let info = null;
  while (Date.now() - start < timeoutMs) {
    info = await page.evaluate(() => {
      const c = document.querySelector("#screen_container canvas");
      let colors = 0;
      if (c && c.width && c.height) {
        try {
          const ctx = c.getContext("2d", { willReadFrequently: true });
          const d = ctx.getImageData(0, 0, c.width, c.height).data;
          const seen = new Set();
          for (let i = 0; i < d.length; i += 4 * 97) {
            seen.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
          }
          colors = seen.size;
        } catch {}
      }
      return {
        width: c?.width || 0,
        height: c?.height || 0,
        colors,
        status: document.getElementById("status")?.textContent || "",
      };
    });
    if (info.width >= minWidth && info.colors >= minColors) return info;
    await page.waitForTimeout(2000);
  }
  throw new Error(
    `Timed out booting ${osId}: last=${JSON.stringify(info)} after ${timeoutMs}ms`
  );
}

// Boot a guest with a serial console and drive it. Used for the rigorous
// end-to-end networking test. Drives a Buildroot Linux (busybox).
export async function startSerialVM(page, { nic = "ne2k", relayUrl = "wisps://anura.pro/", memoryMb = 128 } = {}) {
  // Use the runner page (has the no-referrer policy + libv86 module) but with an
  // unknown os id so it does not start its own emulator.
  await page.goto(`/run.html?os=__test_harness__`, { waitUntil: "domcontentloaded" });
  await page.evaluate(async ({ nic, relayUrl, memoryMb }) => {
    const { V86 } = await import("./vendor/libv86.mjs");
    window.__serial = "";
    window.__send = 0;
    window.__recv = 0;
    const emu = new V86({
      wasm_path: "vendor/v86.wasm",
      bios: { url: "vendor/bios/seabios.bin" },
      vga_bios: { url: "vendor/bios/vgabios.bin" },
      autostart: true,
      memory_size: memoryMb * 1024 * 1024,
      net_device: { type: nic, relay_url: relayUrl },
      // Resilience: boot from our self-hosted mirror (same-origin, copy.sh-
      // independent). Falls back to copy.sh only if the mirror is absent.
      bzimage: { url: new URL("mirror/buildroot-bzimage.bin", location.href).href, size: 5166352, async: false },
      cmdline: "console=ttyS0 tsc=reliable mitigations=off random.trust_cpu=on",
      filesystem: {},
      disable_speaker: true,
    });
    window.__emu = emu;
    emu.add_listener("serial0-output-byte", (b) => {
      window.__serial += String.fromCharCode(b);
      if (window.__serial.length > 80000) window.__serial = window.__serial.slice(-50000);
    });
    emu.add_listener("net0-send", () => { window.__send++; });
    emu.add_listener("net0-receive", () => { window.__recv++; });
  }, { nic, relayUrl, memoryMb });
}

export const getSerial = (page) => page.evaluate(() => window.__serial || "");
export const sendSerial = (page, s) => page.evaluate((x) => window.__emu.serial0_send(x), s);
export const netCounts = (page) => page.evaluate(() => ({ send: window.__send || 0, recv: window.__recv || 0 }));

export async function waitForSerial(page, re, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = await getSerial(page);
    if (re.test(s)) return s;
    await page.waitForTimeout(1000);
  }
  const s = await getSerial(page);
  throw new Error(`Timed out waiting for ${label}. Serial tail:\n${s.slice(-1500)}`);
}
