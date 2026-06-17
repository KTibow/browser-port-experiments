import { test, expect } from "@playwright/test";
import { startSerialVM, sendSerial, waitForSerial, netCounts } from "./helpers.mjs";

// The "loads a page" proof (PLAN task 3): a *real browser engine* fetches AND
// renders a live web page over Wisp, asserted in CI.
//
// Most guest browsers are GUI apps and the runner's canvas mouse is relative-mode
// PS/2 (absolute Playwright clicks land in the wrong place), which has blocked
// per-OS GUI automation. So instead we drive a *text-mode* browser over the
// serial console — the path the PLAN recommends ("Linux guests can run links").
//
// We reuse the proven Buildroot + serial + Wisp harness and overlay a static
// `links` (Twibright Links 2.29, ELF32 i386, musl) via an external initrd
// (mirror/links-initrd.cpio.gz). The kernel extracts that on top of buildroot's
// built-in initramfs, so /usr/bin/links + its musl libs + a CA bundle appear in
// the running rootfs. `links -dump` renders HTML to laid-out text — so asserting
// on that text (and the ABSENCE of HTML tags) proves a browser engine actually
// parsed and rendered the page, not that we merely fetched bytes.
test("a real browser (links) renders a live page over Wisp @browse", async ({ page }) => {
  test.setTimeout(200_000);
  await startSerialVM(page, {
    nic: "ne2k",
    relayUrl: "wisps://anura.pro/",
    memoryMb: 256,
    initrd: "mirror/links-initrd.cpio.gz",
  });

  // Wait for the busybox shell prompt.
  await waitForSerial(page, /~% $|# $/, 90_000, "shell prompt");

  // The static browser was overlaid by the initrd and is runnable.
  await sendSerial(page, "/usr/bin/links -version 2>&1 | head -1; echo LINKSVER_$?\n");
  const ver = await waitForSerial(page, /LINKSVER_\d/, 15_000, "links runs");
  expect(ver, "links binary runs in the guest").toMatch(/LINKSVER_0/);
  expect(ver, "it really is Twibright Links").toMatch(/Links\s+\d/i);

  // Bring up eth0 + DHCP over Wisp.
  await sendSerial(page, "udhcpc -i eth0 -n -q 2>&1\n");
  const dhcp = await waitForSerial(page, /lease of [\d.]+ obtained|No lease/i, 40_000, "dhcp lease");
  expect(dhcp).toMatch(/lease of [\d.]+ obtained/i);

  // ---- HTTP: render a real page through the browser over Wisp. ----
  const httpMarker = "BROWSE_HTTP";
  await sendSerial(page, `/usr/bin/links -dump http://example.com/ 2>&1 | head -c 1200; echo; echo ${httpMarker}_$?\n`);
  const http = await waitForSerial(page, new RegExp(httpMarker + "_\\d"), 60_000, "links http render");

  expect(http, "links exited 0").toMatch(new RegExp(httpMarker + "_0"));
  // Rendered (laid-out) page text, fetched over Wisp.
  expect(http, "rendered the page title").toMatch(/Example Domain/);
  expect(http, "rendered the body paragraph").toMatch(/domain is for use/i);
  // Crucially: it is *rendered* text, not the raw HTML source (a browser engine
  // parsed it). The dump between the title and the marker has no HTML tags.
  const rendered = http.slice(http.indexOf("Example Domain"), http.indexOf(httpMarker + "_"));
  expect(rendered, "dump is rendered text, not raw HTML").not.toMatch(/<\/?(html|head|title|body|p|a|div)\b/i);

  // ---- HTTPS: prove TLS works over Wisp too (links' bundled openssl + CA bundle). ----
  const tlsMarker = "BROWSE_HTTPS";
  await sendSerial(page, `/usr/bin/links -dump https://example.com/ 2>&1 | head -c 600; echo; echo ${tlsMarker}_$?\n`);
  const tls = await waitForSerial(page, new RegExp(tlsMarker + "_\\d"), 60_000, "links https render");
  expect(tls, "https (TLS over Wisp) exited 0").toMatch(new RegExp(tlsMarker + "_0"));
  expect(tls, "rendered the page over TLS").toMatch(/Example Domain/);

  // And the network was actually used (frames transmitted over Wisp).
  const counts = await netCounts(page);
  expect(counts.send, "guest transmitted ethernet frames over Wisp").toBeGreaterThan(0);
});
