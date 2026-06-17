# PLAN — coordination doc for agents

This is the shared brain for the agent chain. **Read this first.** Update it as
you work (status table + log), then keep the chain alive (see the bottom).

## What we're building

Useful web browsers that run entirely in the visitor's browser, deployed to
GitHub Pages at https://kendell.dev/browser-port-experiments/ .

## Architecture (decided & proven)

We emulate whole operating systems with **v86** (x86 → WASM) and run their native
browsers. This satisfies the brief precisely: logic = WASM, graphics = canvas,
networking = Wisp.

- **v86 runtime**: vendored from npm `v86@0.5.372` into `vendor/` at build time
  (`libv86.mjs`, `v86.wasm`). SeaBIOS + VGABIOS are committed in `vendor/bios/`.
- **OS images**: streamed on demand from `https://i.copy.sh/` (BunnyCDN; the same
  host that powers the real v86 demo). We do **not** host multi-hundred-MB images
  ourselves (GitHub Pages caps at 100 MB/file, 1 GB/site).
- **CDN hotlink protection (important!)**: `i.copy.sh` returns **403** when a
  `Referer` header from a non-copy.sh origin is present. Fix: the runner page sets
  `<meta name="referrer" content="no-referrer">`. Empty Referer ⇒ 200 + `ACAO:*`.
  Do **not** remove that meta tag.
- **Networking**: `net_device.relay_url = "wisps://anura.pro/"` (v86 maps
  `wisps://` → `wss://`). v86 answers DHCP/ARP/DNS(DoH) locally and tunnels TCP
  over Wisp. **Use `ne2k`** as the NIC for most images; only use `virtio` for
  images built for it (ReactOS, Arch). Buildroot's virtio-net didn't bind; ne2k did.
- **State images** (`*_state-*.bin.zst`) resume a booted desktop instantly and
  **do** restore correctly with the vendored wasm (verified on Windows 98). Memory
  size must match the state; keep the values copied from copy.sh's `main.js`.

Single source of truth = `browsers.json`. The runner (`src/runner.js`) builds the
V86 options from each entry's `config`, prepending the CDN host to every disk/state
`url`.

## Deployment (IMPORTANT — needs owner action)

The Pages site is `build_type: workflow`. **Agents cannot create files under
`.github/workflows/`** (the relay PAT and `GITHUB_TOKEN` are both forbidden from
modifying workflows), and we cannot edit the Pages config via API either. So:

- The deploy workflow lives at `docs/deploy-pages-workflow.example.yaml`.
- The repo **owner must copy it** to `.github/workflows/deploy-pages.yaml`
  (this matches the prior convention here, commit "copy over its workflow").
- Until that copy happens, the live URL keeps serving the **previous** attempt
  (an old Vite/NetSurf app from before the repo was rewound). Our new site is
  fully built & tested; it just isn't published yet.
- `npm run build` produces `dist/`; the workflow uploads that to Pages and gates
  on the `@smoke` tests. A second optional `docs/verify-workflow.example.yaml`
  runs the full functional suite on a schedule.

**The workflows are now installed** (owner copied them; `.github/workflows/`
contains `deploy-pages-workflow.yaml` + `verify-workflow.yaml`). BUT pushes made by
the agent token do **not** auto-trigger them (GitHub suppresses workflow runs from
`GITHUB_TOKEN`). **After you push, publish your changes with:**
```bash
gh workflow run "Deploy Pages" --ref main
```
Verify it at https://kendell.dev/browser-port-experiments/ . If you change the
workflow `.example.yaml` files in `docs/`, the owner must re-copy them.

## Verification status

Run `npm test`. Statuses also live in `browsers.json` (`tested` field) and drive
the badge on the landing page.

| id | browser/engine | status | notes |
| --- | --- | --- | --- |
| kolibrios | WebView (+ NetSurf) | ✅ boots | 1024×768 desktop in ~10s; Wisp connects; CI `@smoke` |
| windows95 | Internet Explorer (Trident) | ✅ boots | restores from state in ~2s; CI `@state`; classic teal desktop + IE icon verified; ne2k |
| windows98 | Internet Explorer (Trident) | ✅ boots | restores from state; CI `@state`; needs `networking.bat` |
| windows2000 | IE5 + K-Meleon + Lynx + Retrozilla | ✅ boots | restores from state; CI `@state`; 4 browsers! run `networking.bat` |
| windowsme | Internet Explorer (Trident) | ✅ boots | restores from state in ~2s; CI `@state`; Millennium desktop verified |
| haiku | WebPositive (WebKit) + Links | ✅ boots | restores from state; CI `@state`; run `networking.sh` |
| reactos | IE-compatible shell | ✅ boots | restores from state in ~2s; CI `@state`; virtio NIC, acpi; v0.4.15 desktop verified |
| serenityos | Ladybird (LibWeb) | ✅ boots | **fixed**: parts are zstd (`serenity-v3/.img.zst`, not `.img`); CI `@state`; desktop + terminal verified |
| 9front | Mothra + NetSurf (Plan 9) | ✅ boots | restores from state in ~2s; CI `@state`; rio desktop + `term%` rc shell verified; ne2k, acpi |
| slitaz | Midori + TazWeb (WebKitGTK) | ✅ boots | live boot (ISO as hda); auto-boots through lang menu to a 1280×720 Openbox desktop in ~135s; **DHCP-over-Wisp auto-connects**; CI `@livecd`; Midori+TazWeb confirmed in ISO rootfs |
| android4 | AOSP Browser (WebKit) | ✅ boots | Android-x86 4.4 KitKat; full boot ~4-5min (streams ~250 MB), reaches the real launcher; Wisp connects; CI `@slow` (440s budget) |
| dsl | Dillo + Firefox | ✅ boots | live CD; Syslinux waits at `boot:` so registry uses `autokeys` to press Enter; X11 in ~50s; DHCP-over-Wisp connected; CI `@cdrom` |
| (buildroot) | — (test harness only) | ✅ network | `@network`: DHCP + `wget http://example.com` over Wisp returns real HTML |

The end-to-end **Wisp networking is proven** (the `@network` test fetches a live
page). Each guest's own browser still needs a per-OS manual/automated check that it
loads a page over Wisp (most guests need their NIC enabled in-OS first).

## Task queue (pick the top unclaimed item)

When you start a task, append a line to the Log with your run id and "claimed".

1. ~~**Verify the unverified browsers boot.**~~ **DONE** (2026-06-17). All 8
   browsers now render a real desktop and are `tested: "boots"`. Boot tests cover
   every OS (`@smoke`/`@state`/`@cdrom`). New helpers: `scripts/probe.mjs` (manual
   single-OS boot+screenshot) and the registry `autokeys` field (unattended boot
   for guests that pause at a prompt, e.g. DSL).
2. ~~**Fix SerenityOS image streaming.**~~ **DONE** (2026-06-17). copy.sh serves
   zstd-compressed parts at `serenity-v3/.img.zst`; the config used `.img`. Now
   fixed and verified booting from CDN.
3. **Per-OS "loads a page" automation.** Where feasible, script the guest to open
   its browser and load a page over Wisp, asserting on pixels or, better, on serial
   for text browsers. KolibriOS has a CLI; Linux guests can run `links`.
4. **Add more useful browsers.** *(in progress — SliTaz + Android 4.4 added & verified.)*
   More candidates with real engines on the copy.sh CDN: TinyCore (needs a browser
   extension fetched), 9front (mothra), FreeBSD (console — needs `links`/X), Redox
   (state image; check for a browser), Windows 95 (IE). Windows XP is **not** on the
   copy.sh CDN. Keep images CDN-streamable; don't commit big blobs.
5. **Resilience.** Mirror the *small* critical images (kolibri.img, buildroot) into
   the repo or a GitHub Release as a fallback `?cdn=` source, so a copy.sh outage
   doesn't take the whole site down. Verify CORS + range support on the mirror.
6. **Polish UX.** Per-OS "how to browse" hints on the runner page (e.g. Win98:
   double-click `networking.bat`, then Internet Explorer). Loading progress bar.
   Mobile/touch input. A relay picker (anura.pro default + alternatives).

Keep changes small and verified. Don't break `@smoke` (it gates deploy).

## Conventions

- Don't commit `node_modules/`, `dist/`, or test artifacts (see `.gitignore`).
- `npm run build` must stay green; `npx playwright test --grep @smoke` must pass.
- Image `url`s in `browsers.json` are CDN-relative (no leading host).
- Be honest in the `tested` field; the badge reflects it publicly.

## Keeping the chain alive (required)

Every agent must ensure another agent will keep working after it. Before you
finish: commit & push, then trigger the next worker:

```bash
gh workflow run run-agent.yaml -f prompt="$(cat .pi/next-agent-prompt.md)"
```

`.pi/next-agent-prompt.md` contains the standing instructions for the next worker
(read PLAN.md, pick a task, verify, commit/push, spawn the next agent). Update that
file if the process should change. Avoid spawning many agents at once — keep a
single relay going unless there's clearly parallelizable, conflict-free work.

## Log

- 2026-06-17 — **orchestrator (run #1)**: Scaffolded everything. Chose & proved the
  v86 + i.copy.sh + Wisp(anura.pro) architecture. Built site (registry-driven
  index + runner), vendored v86 + BIOS, deploy + verify workflows, Playwright
  suite. Verified: KolibriOS graphical boot, Windows 98 state restore, and
  end-to-end Wisp fetch of a live page. Discovered & fixed the CDN Referer 403
  (no-referrer) and the ne2k-vs-virtio NIC issue. Queued tasks above.
- 2026-06-17 — **orchestrator (run #1, cont.)**: Owner installed the workflows.
  Verified Windows 2000 (IE5 + K-Meleon + Lynx + Retrozilla) and Haiku
  (WebPositive + Links) restore from state; added per-OS browsing hints + a hint
  bar. Deployed and **verified the LIVE production site**
  (https://kendell.dev/browser-port-experiments/): KolibriOS boots in ~13s, Wisp
  connected, 0 page errors. Documented the manual `gh workflow run "Deploy Pages"`
  step. Site is live with 8 browsers (4 verified). Spawned the next worker.
  Next up (task queue): verify ReactOS/SerenityOS/DSL/Windows ME; fix SerenityOS
  part URLs; per-OS "loads a page" automation.
- 2026-06-17 — **worker**: claimed Task 1 (verify unverified browsers) + the
  SerenityOS part-URL half of Task 2. Probed the CDN: windowsme
  (`windowsme-v3/0-262144.img`) and reactos (`reactos-v3/0-1048576.img`) parts
  resolve fine — configs were already correct, just unverified. SerenityOS 404'd
  because copy.sh serves **zstd-compressed** parts at `serenity-v3/.img.zst` (not
  `.img`); `serenity-v3/0-1048576.img.zst` returns 206. Fixing the config and
  booting windowsme/reactos/serenity with screenshot probes to set `tested`.
- 2026-06-17 — **worker (cont.)**: **Completed Tasks 1 + 2.** Verified all four
  remaining browsers render real desktops (read the PNGs, not just pixel stats):
  • **Windows ME** — state restore ~2s, Millennium desktop w/ Office icons.
  • **ReactOS** — state restore ~2s, ReactOS 0.4.15-x86 desktop (virtio NIC).
  • **SerenityOS** — fixed `.img→.img.zst`; boots to desktop + terminal
    (`anon@courage`), Ladybird/LibWeb available.
  • **Damn Small Linux** — live CD; X11 fluxbox desktop in ~50s with FireFox/Dillo
    apps menu, and it **got a DHCP lease over Wisp** ("Wisp: connected",
    192.168.86.100). All set to `tested: "boots"`.
  Added boot tests: windowsme/reactos/serenityos to the `@state` list, plus a new
  `@cdrom` DSL test (asserts the X11 desktop, not the boot splash). `@smoke` still
  green (3 passed). New: `scripts/probe.mjs` for manual single-OS boot+screenshot.
  **Gotchas learned:** (1) SerenityOS parts are zstd — use `.img.zst`. (2) Each
  image's part chunk size differs (windowsme=256K, reactos/serenity=1M); probe the
  *right* `0-<chunk>.img[.zst]` URL or you get false 404s. (3) DSL's Syslinux sits
  at an interactive `boot:` prompt; added a generic data-driven `autokeys`
  (`[{delay,text}]`) to the runner so such guests boot unattended — verified DSL
  reaches X11 with no manual keypress. Next up: Task 3 (per-OS "loads a page"
  automation) or Task 5 (mirror small images for CDN resilience).
- 2026-06-17 — **worker**: claimed Task 4 (add more useful browsers). Surveyed the
  copy.sh profile list and added **two new, fully-verified browsers** (now 10 total,
  6 verified):
  • **SliTaz GNU/Linux (rolling 2024)** — a <60 MB live Linux that auto-boots to a
    1280×720 Openbox desktop in ~135s. **Confirmed it ships Midori (WebKitGTK 1.0)
    + TazWeb** by extracting the ISO's LZMA-cpio rootfs layers (`/usr/bin/midori`,
    `libwebkitgtk-1.0.so`, `midori.desktop`). DHCP-over-Wisp comes up on its own
    (TazPkg tried to fetch package lists). Probe + a real `@livecd` Playwright test
    both pass; eyeballed the desktop screenshot (spider wallpaper, icons, panel).
  • **Android 4.4 KitKat (android-x86)** — streams ~250 MB; full software-emulated
    boot takes ~4-5 min but reaches the **real Android launcher** (home screen,
    status-bar clock, nav bar, "Welcome" first-run card), with the WebKit AOSP
    Browser. Wisp connects. Added a `@slow` test (440s budget) that requires the
    800×600 launcher with ≥45 colors (rules out the low-color boot animation) —
    passes; verified the launcher screenshot, not a crash.
  **Gotchas learned:** (1) The runner's `<canvas>` mouse is **relative-mode PS/2**,
  so Playwright absolute clicks land in the wrong place — don't rely on GUI clicks
  for verification; inspect the ISO instead (`7z e iso boot/rootfs*.gz`, then
  `lzma -dc | cpio -idm` — SliTaz rootfs are LZMA, not gzip, despite the `.gz`).
  (2) Boot menus/splashes can have *more* colors than the eventual desktop, so
  thresholds must combine **width + colors** (GRUB 640×480 vs launcher 800×600).
  (3) `npx playwright test` reuses the dev server only when `CI` is unset; on the
  runner `CI=true`, so kill any manual `serve.mjs` first. Added `scripts/watch.mjs`
  (boot-timeline logger + interval screenshots) for slow guests. `@smoke` still
  green (3 passed). Next: more browsers (Task 4 has candidates left) or Task 3/5.
- 2026-06-17 — **worker (cont.)**: **Completed** the 9front add (now 11 browsers,
  7 verified). Verified by reading the screenshot: 9front restores from its state
  image in ~2s to the real Plan 9 **rio** desktop — grey background, the classic
  cut/snarf/paste menu widget top-left, and a working `term%` **rc** shell window
  (1024×768). Set `tested: "boots"` and added a `@state` boot test (passes in
  2.4s); `@smoke` still green (3 passed). **Gotcha learned:** rio uses
  *focus-follows-mouse*, and our canvas mouse is relative-PS/2 (same gotcha that
  blocks GUI automation elsewhere), so `keyboard_send_text` doesn't reach the
  term window unless the pointer is parked over it — couldn't reliably home the
  cursor, so in-guest mothra/networking verification stays manual (Task 3), like
  the other GUI guests. Also: the public V86 wrapper exposes mouse moves only via
  `emulator.bus.send("mouse-delta",[dx,dy])` / `"mouse-click"` (there's no public
  `mouse_send_delta` method). Next: more browsers (Task 4: TinyCore, FreeBSD,
  Windows 95, Redox) or Task 3/5.
- 2026-06-17 — **worker (run: win95)**: **Completed** the Windows 95 add (now 12
  browsers, 8 verified). Task 4 (add more browsers), proven low-risk state-restore
  pattern. CDN: copy.sh's *old* win95 profile pairs `w95/.img` (parts
  `w95/0-262144.img`, 256K chunks, 242049024 B, **32 MB RAM**) with
  `windows95_state.bin.zst` (valid zstd magic `28 b5 2f fd`); both resolve 206 +
  ACAO with no Referer. (The newer `windows95-v2/.img` has no state and cold-boots
  slowly, so I used the state image for a fast resume.) **Verified by reading the
  screenshot**: restores in ~2s to the real Windows 95 desktop — classic teal
  background, Network Neighborhood / Recycle Bin / (C:) / Control Panel / System,
  and the **Internet Explorer** icon (IE globe). Set `tested: "boots"`; added a
  `@state` boot test (passes in 2.4s, asserts ≥800 width + ≥9 colors so the
  mostly-teal desktop clears it). `@smoke` still green (3 passed). **Gotcha:** the
  win95 *state* pairs with the older `w95/.img` at **32 MB RAM** (memory must match
  the state); the current `windows95-v2` profile is stateless. Next: more browsers
  (Task 4: TinyCore, FreeBSD, Redox) or Task 3/5.
- 2026-06-17 — **worker**: claimed **Task 4** (add more browsers). Picked **9front**
  (Plan 9 fork; ships Mothra + NetSurf) because it has a state image — the proven,
  low-risk @state restore pattern — and is a genuinely useful, actively-developed
  OS. (Chose Task 4 over the queue-top Task 3 because Task 3's GUI automation is
  blocked by the relative-mouse gotcha, there's no confirmed serial+browser guest,
  and the existing @network test already proves E2E Wisp fetch.) Verified CDN
  parts + state resolve (206, ACAO:*) with no Referer; ne2k NIC, acpi, 128 MB.
  Probing a boot + reading the screenshot before flipping `tested`.
