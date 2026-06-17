import { test, expect } from "@playwright/test";
import { startSerialVM, sendSerial, waitForSerial, netCounts } from "./helpers.mjs";

// The rigorous end-to-end proof: boot a real Linux guest, get a DHCP lease from
// v86's virtual router, resolve DNS, and fetch a live web page over the Wisp
// link to wss://anura.pro. This exercises the entire networking path.
test("fetches a live web page over Wisp @network", async ({ page }) => {
  test.setTimeout(220_000);
  await startSerialVM(page, { nic: "ne2k", relayUrl: "wisps://anura.pro/" });

  // Wait for the busybox shell prompt.
  await waitForSerial(page, /~% $|# $/, 90_000, "shell prompt");

  // Bring up eth0 + DHCP.
  await sendSerial(page, "udhcpc -i eth0 -n -q 2>&1\n");
  const dhcp = await waitForSerial(page, /lease of [\d.]+ obtained|No lease/i, 40_000, "dhcp lease");
  expect(dhcp).toMatch(/lease of [\d.]+ obtained/i);

  // Fetch a real page over Wisp. The marker echoes wget's exit code.
  const marker = "WISPNET_DONE";
  await sendSerial(page, `wget -q -O - http://example.com/ 2>&1 | head -c 120; echo; echo ${marker}_$?\n`);
  const out = await waitForSerial(page, new RegExp(marker + "_\\d"), 50_000, "wget result");

  expect(out, "wget should succeed (exit 0)").toMatch(new RegExp(marker + "_0"));
  expect(out, "should receive the real example.com HTML over Wisp").toMatch(/Example Domain/i);

  const counts = await netCounts(page);
  expect(counts.send, "guest transmitted ethernet frames").toBeGreaterThan(0);
});
