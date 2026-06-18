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
| kolibrios | WebView (+ NetSurf) | ✅ boots | 1024×768 desktop in ~10s; Wisp connects; **self-hosted (`mirror/kolibri.img`, copy.sh-independent)**; CI `@smoke` |
| windows95 | Internet Explorer (Trident) | ✅ boots | restores from state in ~2s; CI `@state`; classic teal desktop + IE icon verified; ne2k |
| windows98 | Internet Explorer (Trident) | ✅ boots | restores from state; CI `@state`; needs `networking.bat` |
| windows2000 | IE5 + K-Meleon + Lynx + Retrozilla | ✅ boots | restores from state; CI `@state`; 4 browsers! run `networking.bat` |
| windowsme | Internet Explorer (Trident) | ✅ boots | restores from state in ~2s; CI `@state`; Millennium desktop verified |
| haiku | WebPositive (WebKit) + Links | ✅ boots | restores from state; CI `@state`; run `networking.sh` |
| reactos | IE-compatible shell | ✅ boots | restores from state in ~2s; CI `@state`; virtio NIC, acpi; v0.4.15 desktop verified |
| serenityos | Ladybird (LibWeb) | ✅ boots | **fixed**: parts are zstd (`serenity-v3/.img.zst`, not `.img`); CI `@state`; desktop + terminal verified |
| 9front | Mothra + NetSurf (Plan 9) | ✅ boots | restores from state in ~2s; CI `@state`; rio desktop + `term%` rc shell verified; ne2k, acpi |
| redox | NetSurf (Orbital GUI) | ✅ boots | modern Rust microkernel OS; restores from state to the Orbital **login** screen, then `autokeys` auto-logs-in (`user`/empty pw) → JWST-wallpaper desktop (~80s for the wallpaper to decode); CI `@state`. **ne2k** (state was saved with the ne2k default — virtio corrupts state/triple-faults); Redox has no ne2k driver so in-guest networking is unavailable on this path (see Log) |
| slitaz | Midori + TazWeb (WebKitGTK) | ✅ boots | live boot (ISO as hda); auto-boots through lang menu to a 1280×720 Openbox desktop in ~135s; **DHCP-over-Wisp auto-connects**; CI `@livecd`; Midori+TazWeb confirmed in ISO rootfs |
| android4 | AOSP Browser (WebKit) | ✅ boots | Android-x86 4.4 KitKat; full boot ~4-5min (streams ~250 MB), reaches the real launcher; Wisp connects; CI `@slow` (440s budget) |
| beos | NetPositive (Be Inc.) | ✅ boots | BeOS 5 PE; cold-boots from a streamed disk (~90-100 MB to the desktop) in ~35-70s; `autokeys` clears the boot-loader's text "Partition Manager Menu"; full blue Tracker/Deskbar desktop verified; **Wisp connects on its own**; ne2k; CI `@coldboot` |
| dsl | Dillo + Firefox | ✅ boots | live CD; Syslinux waits at `boot:` so registry uses `autokeys` to press Enter; X11 in ~50s; DHCP-over-Wisp connected; CI `@cdrom` |
| (buildroot) | links 2.29 (Twibright) | ✅ renders | `@browse`: a real text-browser **renders** a live page over Wisp (HTTP+HTTPS); also `@network` (DHCP + `wget`) |

The end-to-end **Wisp networking is proven** (`@network` fetches a live page) and a
**real browser engine rendering a live page over Wisp is now proven in CI**
(`@browse` runs Twibright Links via the serial console and asserts on the *rendered*
text for both HTTP and HTTPS/TLS). The GUI guests' *own* browsers (IE/WebKit/etc.)
still need a per-OS GUI check (blocked by the relative-mouse gotcha — see Task 3
notes); the `@browse` proof covers the "a real browser loads a page over Wisp"
claim with a fully automated, deterministic test.

## Task queue (pick the top unclaimed item)

> Status: Tasks 1, 2, 3, 5 and **6 are DONE**. The only open item is **Task 4**
> (add more browsers) — still worthwhile (14 browsers, 10 verified; named
> candidates remain, see the Task 4 notes). Future-work ideas: Task 3's GUI
> page-load via a relative-mouse corner-pin trick; a modern-engine browser if a
> CDN-streamable image exists (Icaros/AROS OWB is the strongest such candidate).

When you start a task, append a line to the Log with your run id and "claimed".

1. ~~**Verify the unverified browsers boot.**~~ **DONE** (2026-06-17). All 8
   browsers now render a real desktop and are `tested: "boots"`. Boot tests cover
   every OS (`@smoke`/`@state`/`@cdrom`). New helpers: `scripts/probe.mjs` (manual
   single-OS boot+screenshot) and the registry `autokeys` field (unattended boot
   for guests that pause at a prompt, e.g. DSL).
2. ~~**Fix SerenityOS image streaming.**~~ **DONE** (2026-06-17). copy.sh serves
   zstd-compressed parts at `serenity-v3/.img.zst`; the config used `.img`. Now
   fixed and verified booting from CDN.
3. ~~**Per-OS "loads a page" automation.**~~ **DONE** (2026-06-17, run: browse).
   Took the PLAN's own recommended route ("Linux guests can run `links`" over
   serial). New `@browse` test: boots the mirrored Buildroot kernel + a static
   `links` text browser overlaid via an external initrd
   (`mirror/links-initrd.cpio.gz`, built by `scripts/build-links-initrd.sh` from
   Alpine x86 packages), gets DHCP over Wisp, then `links -dump`s example.com over
   **HTTP and HTTPS** and asserts on the *rendered* (tag-free) page text — a real
   browser engine fetching AND rendering a live page over Wisp, in ~13s, fully
   deterministic. **Still open (GUI guests):** driving each guest's *own* GUI
   browser (IE/WebKit/Ladybird/...) is still blocked by the relative-mouse gotcha
   (absolute Playwright clicks land wrong; v86's absolute mouse needs an in-guest
   VMware driver none of these ship). Candidate future work: a corner-pin
   relative-mouse trick per-OS, or a VMware-mouse-aware guest.
4. **Add more useful browsers.** *(in progress — SliTaz, Android 4.4, 9front, Win95,
   Redox and **BeOS 5** added & verified — now 14 browsers, 10 verified.)*
   Remaining candidates with real engines on the copy.sh CDN, in rough
   value/effort order:
   - **Icaros Desktop (AROS)** — `icaros-pc-i386-2.3/.iso` (726 MB, 512K parts).
     Ships **OWB (Origyn Web Browser, WebKit)** — a genuinely useful WebKit engine
     on an AmigaOS-like platform. Cold-boot live CD; copy.sh notes ~136 MB / 287
     requests to boot, so it'll be a `@slow`-style test. Not yet verified to reach
     the Wanderer desktop (may need `acpi` and/or an `autokeys` Enter). **Tiny
     Aros** (`tinyaros-pc-i386/.iso`, 111 MB) is a smaller AROS alternative —
     check whether it ships OWB before preferring it.
   - **Windows NT 4.0** — `winnt4_noacpi/.img` (cold boot, no state, `cpuid_level: 2`).
     Ships IE; but we already have a lot of IE/Trident, so lower novelty.
   - **Syllable** (`syllable-destop-0.6.7/.img`) ships ABrowse; **ToaruOS** has only
     a minimal browser; **FreeBSD** (state) is console (needs `links`/X). TinyCore
     needs a browser extension fetched. Windows XP is **not** on the copy.sh CDN.
   Keep images CDN-streamable; don't commit big blobs. **Gotcha (BeOS):** its boot
   loader pauses at a text "Partition Manager Menu" (`untitled` highlighted) — the
   `autokeys` Enter mechanism (originally for DSL/Redox) clears it; and the
   *graphical* canvas stays 300x150 while a guest is in text mode, so the
   color/width probe only "sees" the screen once it goes VGA graphical.
5. ~~**Resilience.**~~ **DONE** (2026-06-17). The two *small* critical images are
   now self-hosted in the repo `mirror/` (built into `dist/mirror/`, served
   same-origin by Pages with range support): `kolibri.img` (1.44 MB — the flagship
   + the `@smoke` deploy gate) and `buildroot-bzimage.bin` (5 MB — the `@network`
   Wisp proof). An image's `mirror` field makes the runner prefer the same-origin
   copy unless `?cdn=` forces a host. Result: a copy.sh outage can no longer block
   deploys or break the flagship/`@network`. `?cdn=https://i.copy.sh/` still streams
   from copy.sh (covered by the new `@cdn` regression test). Larger images (the
   Windows/Haiku/etc. multi-hundred-MB disks) stay copy.sh-only — too big to host.
6. **Polish UX.** *(DONE 2026-06-17.)* Done: per-OS "how to browse" hints (hint bar);
   a visual **loading progress bar** (shows the streaming file + %/MB, indeterminate
   sweep when total is unknown); a **Wisp relay picker** (registry `relays` list +
   Custom…, switches via `?relay_url=` reload); **mobile/touch input** (tap=left
   click, long-press=right click, a ⌨ keyboard toggle that focuses a
   `.phone_keyboard` so v86 forwards keys; `touch-action:none` + responsive
   toolbar; v86 already does drag→move). All shipped & verified 2026-06-17.
   **DONE (run: dl-hint):** an up-front **download-size hint**. Every landing card
   shows a pill with the data commitment (e.g. KolibriOS "down 1.4 MB", Android
   "down ~236 MB") and the runner bar shows it before any image streams
   ("down ~236 MB streamed" under the engine name). Sizes are honest, measured from
   the CDN: state-restore OSes show the saved-state `.zst` downloaded
   fully+immediately to resume (`mode:"resume"`, tooltip notes disk parts then
   stream on use); full-download floppy/ISOs show the whole file (`mode:"full"`);
   Android shows the ~236 MB it streams as it boots (`mode:"stream"`). New shared
   `src/download-format.mjs` (used by both the build and the runner), a `download`
   field per `browsers.json` entry, and 2 deterministic `@ux` tests. **Task 6 is
   now fully complete.**

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

- 2026-06-17 — **worker (run: beos)**: claimed **Task 4** (add more browsers — the
  only open queue item) and **added + verified BeOS 5** (now **14 browsers, 10
  verified**). Picked BeOS for novelty + a famous, beloved engine (NetPositive)
  and because it turned out to be a clean, reliable cold-boot. **Verified for real
  (read the screenshots, not just a green check):**
  • BeOS cold-boots from the streamed `beos5/.img` disk. Its boot loader stops at a
    text-mode **"Partition Manager Menu"** (`▶ untitled ◄`, "Select an OS from the
    menu") — I caught this in a probe screenshot. The runner's existing **`autokeys`**
    (Enter presses at 8/16/26s) clears it unattended; then the iconic BeOS 5 boot
    splash (800x600, mostly black + purple logo + rocket icons, ≤18 sampled colors)
    gives way to the full **blue Tracker/Deskbar desktop** (800x600, ~30 colors)
    in ~35-70s. I read the desktop screenshot: classic blue bg, the **Deskbar**
    (Be logo + clock + Tracker) top-right, and desktop icons (`untitled`,
    `BeOS Cool Stuff`, `Welcome to BeOS`, `home`, a Japanese-named saver) —
    unmistakably a booted BeOS, not a crash.
  • **Wisp networking comes up on its own** — the status bar flipped to
    "Wisp: connected (wisps://anura.pro/)" (green; `net0-send` fired) ~5s after the
    desktop, with **0 page errors**. (NetPositive itself is GUI-launched, blocked
    by the relative-mouse gotcha like the other GUI guests — the desktop + working
    Wisp + the shipped browser are the honest `tested: "boots"` claim.)
  • New **`@coldboot`** test (`beos boots BeOS 5 to the Tracker desktop`): asserts
    the 800x600 desktop (≥780 wide, **≥25 colors** so the boot splash can't pass)
    — passed in **59.3s**; **`@smoke` still green** (4 passed together), and
    **`@ux` still green** (5 passed: the new card's `↓ ~100 MB` chip validates).
  • **Honest download hint:** measured the boot streaming **~90 one-megabyte disk
    parts to reach the desktop**, so `download: {bytes: 100 MB, mode: "stream"}`
    (the full image is 512 MB but boot reads only ~100 MB). The card shows
    "↓ ~100 MB" and the runner bar "↓ ~100 MB streamed".
  **Gotchas learned:** (1) BeOS's boot loader pauses at a *text-mode* partition
  menu — needs an `autokeys` Enter; the generic mechanism (DSL/Redox) handled it.
  (2) v86's **graphical** canvas stays 300x150 while a guest is in **text mode**
  (BeOS boots in text first), so the color/width probe reads nothing until VGA
  graphics start — don't conclude "stuck" from a 300x150 canvas; screenshot it (the
  text screen renders to a separate element). (3) Our vendored seabios is 128 KB,
  so BeOS boots fine (copy.sh notes BeOS *segfaults with a 256 KB BIOS*). (4)
  Cross-origin 206 responses don't expose `content-length`/`content-range` to
  Playwright, so I counted 1 MB part *requests* to size the download honestly.
  **Queued for the next agent:** Icaros Desktop (AROS) — ships OWB (WebKit), the
  strongest remaining modern-engine candidate (see Task 4 notes).
- 2026-06-17 — **worker (run: dl-hint)**: **Completed Task 6** (the whole UX-polish
  task is now done) by shipping the up-front **download-size hint**. Verified by
  reading screenshots (not just green checks):
  • **Landing page** — every one of the 13 cards now shows a size pill at the
    bottom-right: KolibriOS "↓ 1.4 MB", Win2000 "↓ 28 MB", Win95 "↓ 4.2 MB",
    Haiku "↓ 36 MB", SliTaz "↓ 54 MB", DSL "↓ 50 MB", **Android "↓ ~236 MB"**, etc.
    Eyeballed the full-page screenshot — pills render cleanly on every card.
  • **Runner bar** — booted Android and read the screenshot: "↓ ~236 MB streamed"
    shows under the engine name *before* the stream completes (the GRUB screen was
    already up), with the full sentence as a tooltip — so a mobile visitor sees the
    commitment up front.
  • Numbers are **honest, measured from the CDN** (HEAD on each state `.zst` + the
    full-download ISO/floppy sizes; Android = its ~236 MB ISO that boot reads most
    of). The hint distinguishes three modes: `resume` (state `.zst` downloaded
    fully+immediately, tooltip says disk parts then stream on use), `full` (whole
    floppy/ISO), `stream` (Android). Also harmonized Android's hint text
    ("~250 MB" → "~236 MB") to match the measured chip.
  • **Mechanism/files:** new shared `src/download-format.mjs` (`formatDownload`/
    `formatBytes`, dependency-free, imported by *both* `scripts/build.mjs` for the
    card chip AND `src/runner.js` for the bar note — single source of truth); a
    `download: {bytes, mode}` field per `browsers.json` entry; `.card__foot` +
    `.card__dl` + `.bar__dl` CSS. **2 new deterministic, offline `@ux` tests**
    (assert every card's chip == `formatDownload(entry).short` + correct title, and
    the runner bar shows the chip/title). **`@ux`+`@smoke` = 8 passed together;**
    KolibriOS still boots (13s) so the deploy gate stays green. **Gotcha re-learned:**
    `pkill -f 'scripts/serve'` kills its *own* shell (its command line contains the
    pattern) — use a regex like `serve[.]mjs` whose literal text differs. **Queue
    now:** only Task 4 (more browsers) remains open; added future-work notes.
- 2026-06-17 — **worker (run: dl-hint)**: claimed **Task 6 remainder** (the
  download size/ETA hint shown up front for the multi-hundred-MB images). Rationale
  over queue-top Task 4 (add more browsers): the easy/low-risk state-restore wins
  are exhausted; the named remaining Task 4 candidates (TinyCore needs a browser
  extension fetched, FreeBSD console needs links/X) are higher-risk. The download
  hint is the explicitly-named remaining Task 6 item, high-value (a mobile visitor
  shouldn't accidentally start a ~236 MB Android stream blind), low-risk, and
  fully verifiable offline. Measured honest sizes from the CDN (state `.zst` are
  downloaded fully + immediately to resume; full-download ISOs/floppy; Android
  streams ~236 MB as it boots). Adding a `download` field to `browsers.json`, a
  shared formatter, a chip on each landing card + a runner-bar size note, and a
  deterministic `@ux` test.
- 2026-06-17 — **worker (run: redox)**: **Completed** the Redox OS add (now **13
  browsers**, 9 verified). Verified for real (read the screenshots, not just a
  green check):
  • Redox restores from `redox_state-v2.bin.zst` to the Orbital **login** screen
    (1280×1024, username `user` pre-filled). The runner's existing `autokeys`
    mechanism presses **Enter** (the `user` account has an empty password —
    confirmed in Redox's `config/base.toml`: `[users.user] password = ""`), which
    logs in and brings up the real **Orbital desktop** with the JWST Tarantula
    Nebula wallpaper. I watched the full auto-login flow with NO manual input:
    login(124 colors) → form transition(4) → desktop solid bg(129–133) → wallpaper
    desktop(**11825 colors**) at ~81s. Status "Running", **0 page errors**.
  • Added a dedicated **`@state`** test (`redox … auto-logs-in to the Orbital
    desktop`) that asserts the rich wallpaper desktop (≥1000×, **≥800 colors**) so
    it proves we got **past the login prompt** to the desktop where NetSurf lives
    — not just the login screen. Passes in **1.4m**; `@smoke` still green (3
    passed), and the landing-page test confirms all 13 browsers list.
  **Gotchas learned (important):** (1) **The NIC type must match what the state
    was saved with.** copy.sh's redox profile leaves the NIC at the **ne2k**
    default, so the state captured an ne2k device. Restoring with **virtio**
    (which I tried first, since Redox *has* a `virtio-netd` driver but no ne2k
    driver) changed the PCI layout and **triple-faulted**: status stuck at "CPU
    running…" (emulator-started never fired) and the first keypress caused an
    infinite `do_page_walk`→`call_interrupt_vector` recursion (RangeError: max
    call stack). Switching to **ne2k** restored cleanly. **Consequence:** Redox
    has no ne2k driver, so **in-guest networking is unavailable** on this fast
    state-restore path (Wisp never sees a send). The desktop + browser still work;
    `tested: "boots"` is the honest status (we don't claim networked). A future
    option for Redox networking would be the *cold-boot* image (`redox-boot`, no
    state) with virtio — much slower, deferred. (2) `autokeys` (originally added
    for DSL's `boot:` prompt) generalizes perfectly to **auto-login** — a list of
    `{delay, text}` Enter presses (I send at 6s and 11s for robustness) takes the
    guest from the login screen to the desktop unattended. (3) Redox's Orbital
    wallpaper is a big JPEG that decodes slowly in software emulation (~80s),
    so the desktop only reaches its high color count well after login — budget
    the test accordingly (320s). Next: more browsers (Task 4: TinyCore / FreeBSD /
    Windows NT 4.0), the Task 6 download-size hint, or Task 3 GUI page-load.
- 2026-06-17 — **worker (run: redox)**: claimed **Task 4** (add more useful
  browsers) — the top open queue item; Tasks 1/2/3/5 are done and Task 3's GUI
  remainder is still relative-mouse-blocked. Picked **Redox OS** (the PLAN's own
  listed candidate: "Redox (state image; check for a browser)"). Checked it for a
  browser: Redox's `config/desktop.toml` includes **`netsurf = {}`**, so the demo
  image ships **NetSurf** on the Orbital GUI desktop — a genuinely novel, modern
  platform (Rust microkernel) using the proven low-risk state-restore path. CDN
  parts + `redox_state-v2.bin.zst` resolve (206) with no Referer. copy.sh's redox
  profile leaves the NIC at the ne2k default, but Redox has **no ne2k driver** —
  only `net/virtio-netd` (+ rtl8139/e1000) in its drivers tree — so I'll use
  **virtio** to actually get Wisp networking (1024 MB RAM to match the state,
  acpi). Booting a probe + reading the screenshot before flipping `tested`.

- 2026-06-17 — **worker (run: browse)**: claimed **Task 3** (per-OS "loads a page"
  automation) — the queue-top unclaimed item, deferred by prior agents as
  GUI-mouse-blocked. Took the PLAN's *recommended* serial/text-browser route
  instead of fighting the GUI: prove a real browser engine renders a live page
  over Wisp by driving a text browser over the serial console.
- 2026-06-17 — **worker (run: browse)**: **Completed Task 3** and verified it for
  real (read the rendered output, not just "it compiled"):
  • New **`@browse`** test (`tests/browse.spec.mjs`): boots the mirrored Buildroot
    kernel and overlays a **static Twibright Links 2.29** text browser via an
    **external initrd** (`mirror/links-initrd.cpio.gz`). Key trick: the buildroot
    bzImage has a *built-in* busybox initramfs; the kernel extracts the external
    initrd **on top of** it, so `/usr/bin/links` + its musl libs + a CA bundle
    appear in the running rootfs (no rebuild of buildroot, no toolchain). Then:
    DHCP over Wisp → `links -dump http://example.com` **and** `https://…`.
  • **What it proves:** a real browser *engine* fetches AND **renders** a live
    page over Wisp. The test asserts on the laid-out text ("Example Domain", the
    body paragraph) AND that the dump is **tag-free** (so it's rendered, not raw
    HTML) — for both HTTP and **HTTPS/TLS** (links ships OpenSSL; I added the CA
    bundle so cert verification passes). Runs in **~13s**, fully deterministic.
  • Verified locally: **`@smoke`+`@network`+`@browse` = 5 passed** together;
    `@browse` alone passes in 13.2s; I read the serial dump and saw the real
    rendered page. Re-ran `scripts/build-links-initrd.sh` to confirm the initrd
    is reproducible (it re-generated a working image; test still passed).
  • **Mechanism / files:** `scripts/build-links-initrd.sh` (pulls prebuilt
    32-bit i386/musl binaries from the **Alpine x86** package repo — links, musl,
    openssl, libevent, zlib, bzip2, zstd, ca-certificates — and packs the cpio);
    `tests/helpers.mjs` `startSerialVM({initrd})` now accepts an optional initrd;
    `mirror/links-initrd.cpio.gz` is self-hosted (built into `dist/mirror/`,
    same-origin) so `@browse` is copy.sh-independent like `@network`/`@smoke`.
  **Gotchas learned:** (1) v86 is **32-bit only** — the browser binary must be
  ELF32 i386; Alpine's **x86** (not x86_64) repo provides exactly that, prebuilt
  against musl (whose static/in-binary DNS resolver actually works, unlike static
  *glibc* which silently fails DNS without NSS .so's). (2) The external-initrd
  **overlay** onto a built-in initramfs is the clean way to add files to an
  existing guest without rebuilding it. (3) HTTPS needs a CA bundle in the initrd
  (`/etc/ssl/certs/ca-certificates.crt` + `/etc/ssl/cert.pem`) or links prints
  "Invalid certificate" and bails. (4) `links -dump` is a great CI oracle: it
  emits *rendered* text, so asserting the absence of HTML tags proves a real
  engine processed the page (vs. a bare `wget`). Next: Task 4 (more browsers:
  TinyCore/FreeBSD/Redox) or Task 6 download-size hint, or attack GUI-guest
  page-load via a relative-mouse corner-pin trick.
- 2026-06-17 — **worker (run: touch-input)**: **shipped mobile/touch input**
  (the last named Task 6 item) and verified it for real (bus-level asserts + a
  read screenshot), not just compiled:
  • **tap → left click**, **long-press (500ms) → right click** — implemented in
    `runner.js setupTouchControls()` by sending `mouse-click [..]` on v86's input
    bus (the public wrapper has no mouse_click method). Tap detection uses a
    move-threshold (12px) + time cap (350ms) so drags don't fire a click; the
    tap touchend `preventDefault()`s to suppress the browser's synthetic mouse
    so v86 doesn't also fire a duplicate click.
  • **⌨ Keyboard toggle** focuses an off-screen `<input class="phone_keyboard">`;
    **v86 already forwards** such an element's keys to the guest (keydown on
    desktop/iOS, and `input`/insertText on Android — with a keyCode-229 guard so
    they don't double). We only had to add the element + a focus toggle.
  • **`touch-action:none`** on `#screen_container` (so a drag moves the guest
    cursor instead of scrolling/zooming the page) + a **responsive toolbar**
    (`@media max-width:760px` / `pointer:coarse`: bigger tap targets, sendtext
    flexes). A touch hint is shown only on coarse-pointer devices.
  Tests: new `tests/touch.spec.mjs` (`@touch`, 2 tests, `test.use({hasTouch})`):
  one fast no-boot UI test (touch hint shown, phone_keyboard class, the toggle
  focus/blur cycle), and one E2E that boots KolibriOS and **wraps the input bus**
  to prove a drag emits `mouse-delta`, a tap emits `mouse-click [t,f,f]/[f,f,f]`,
  a long-press emits `mouse-click [f,f,t]`, and a key pressed into #phonekbd is
  forwarded as `keyboard-code 30` (KeyA). All green; **`@smoke`+`@ux`+`@touch`
  = 8 passed together**. **Read the probe screenshots**: the touch hint bar +
  ⌨ Keyboard button render, and a finger-drag visibly moved the KolibriOS cursor
  from center to the top-left icons (trackpad-move works in our page).
  **Gotchas:** (1) v86 ALREADY does touch→delta and ALREADY supports a
  `.phone_keyboard` element — the only missing pieces were tap/long-press click +
  exposing a keyboard target; don't re-implement delta (you'll double the cursor
  speed). (2) A toolbar `<button>` steals focus on mousedown *before* its click
  handler, so an activeElement-based toggle never closes — fix: `mousedown`
  `preventDefault()` on the toggle so focus stays on #phonekbd (the UI test
  caught this). (3) The relative-PS/2 mouse means a tap clicks where the cursor
  *is*, not where you touch — hence the documented "drag then tap" trackpad model.
  Next: optional Task 6 download-size hint, Task 4 (more browsers: TinyCore /
  FreeBSD / Redox), or Task 3 (per-OS "loads a page", still GUI-mouse-blocked).
- 2026-06-17 — **worker (run: touch-input)**: claimed **Task 6 remainder**
  (mobile/touch input). Rationale: it's the last named Task 6 item and is
  high-value (mobile visitors currently can't click anything) + verifiable.
  Discovered v86 ALREADY does touch→delta (drag moves the cursor) and ALREADY
  has full on-screen-keyboard support for any `<input class="phone_keyboard">`
  (it forwards keydown on desktop/iOS and `input`/insertText on Android, with a
  229-keyCode guard so they don't double) — but our page never added a
  phone_keyboard element or a way to focus it, and v86 has NO tap-to-click. So
  the missing pieces are: tap→left-click + long-press→right-click, a keyboard
  toggle that focuses a phone_keyboard input, `touch-action:none` on the canvas,
  and a responsive toolbar. Implementing + a new `@touch` Playwright test.
- 2026-06-17 — **worker (run: ux-polish)**: **shipped two Task 6 features** and
  verified BOTH against real boots (not just compiled / unit-mocked):
  • **Loading progress bar** (`#progress` in `run.html`): driven by v86's
    `download-progress`; shows `Downloading <file> — N% (loaded / total)` with a
    filling blue bar, or an indeterminate sweep when total is unknown; hidden once
    `emulator-started`. **Read the screenshot**: on a throttled windows95 boot it
    rendered the bar at 21% — "Downloading v86.wasm — 21% (424 KB / 1.97 MB)" —
    over the real runner UI. Huge win for the 250 MB Android / hundreds-of-MB
    Windows streams that used to show only a number.
  • **Wisp relay picker** (`#relay` select): options come from a new registry
    `relays` array (anura.pro default + wisp.mercurywork.shop) plus a Custom…
    (prompt) entry; switching reloads with `?relay_url=` (the relay must be set
    when v86's net device is constructed). **Verified end-to-end**: booted
    kolibrios via the alternate relay and saw v86 actually transmit
    (`net0-send`) — the status bar flipped to "Wisp: connected
    (wisps://wisp.mercurywork.shop/)" (green) and I read that screenshot. Both
    relays were pre-checked to genuinely speak Wisp (each sends the v1 CONTINUE
    handshake frame on connect), so the picker only offers working relays.
  Tests: new `tests/ux.spec.mjs` (`@ux`, 3 tests, fully offline/deterministic —
  drives the progress bar via the `window.__onDownloadProgress` hook and the
  picker via `selectOption`) all green; **`@smoke` still green (3 passed)**;
  `@cdn` still green. `@ux` + `@smoke` + `@cdn` = 7 passed together.
  **Gotchas:** (1) the relay must be chosen *before* `new V86(...)` (net device is
  built at construction) — hence the reload-with-`?relay_url=` approach rather than
  live-swapping. (2) `download-progress` also fires for `v86.wasm` itself, so the
  bar shows that first — fine, it's still "loading". (3) small state `.zst`
  downloads (e.g. win95 = 4.23 MB) whip past too fast to screenshot without CDP
  network throttling. Next: Task 6 remainder (mobile/touch input) or Task 3/4.
- 2026-06-17 — **worker (run: ux-polish)**: claimed **Task 6** (UX polish).
  Rationale over queue-top Task 3: Task 3's per-OS GUI automation is still blocked
  by the relative-mouse gotcha (documented by 3 prior agents) and the *recommended*
  serial-text-browser route needs a CDN Linux image that ships a text browser +
  serial getty (none readily available; rebuilding buildroot with `links` is a
  multi-hour build = too risky for one run), while the `@network` test already
  proves the full Wisp path E2E. Task 6 is high-value + low-risk + fully
  verifiable: (1) a **visual loading progress bar** (every visitor benefits, esp.
  the 250 MB Android / hundreds-of-MB Windows streams that today show only a number),
  and (2) a **Wisp relay picker** for resilience (if anura.pro is blocked, swap
  relays without editing the URL). I verified BOTH candidate relays actually speak
  Wisp before offering them: `wss://anura.pro/` and `wss://wisp.mercurywork.shop/`
  each send the Wisp v1 initial CONTINUE frame (type 3, 9 bytes) on connect.
- 2026-06-17 — **worker (run: resilience)**: **Completed Task 5.** Self-hosted the
  two small critical images and made the flagship + deploy gate + Wisp proof
  copy.sh-independent. Verified end-to-end (not just compiled):
  • `@smoke` (the **deploy gate**) now boots KolibriOS from `mirror/kolibri.img`
    — 3/3 green; the test asserts `window.__usedMirror === true`, and I **read the
    screenshot**: real 1024×768 KolibriOS desktop (NETSURF globe + WebView + app
    icons), "Wisp: connected", 0 page errors. A copy.sh outage can no longer
    block a deploy or break the highlighted demo.
  • `@network` now boots the **mirrored** `buildroot-bzimage.bin` and still does
    the real DHCP + `wget http://example.com` over Wisp — green, and **faster**
    (~5.5s vs streaming) since the kernel is local.
  • New `@cdn` test forces `?cdn=https://i.copy.sh/`, boots kolibri straight from
    copy.sh (mirror bypassed, `__usedMirror === false`) — green; this keeps a
    hotlink/URL regression guard for copy.sh **without** gating deploys on it.
  • `windows95 @state` still green (2.4s) — confirms the CDN path for the
    big state images is unchanged (only images with a `mirror` field switch).
  Mechanism: per-image `mirror` field in `browsers.json`; `resolveImage(host,img,
  preferMirror)` prefers the same-origin mirror unless `?cdn=` is set; `build.mjs`
  copies `mirror/` → `dist/mirror/`; the runner shows "Loading (self-hosted)…".
  Verified the mirror serves Range (206 + Content-Range) locally; on Pages it's
  same-origin so no CORS needed. **Gotchas:** (1) both mirrored files are
  byte-identical to copy.sh (sha256 + boot-sector/bzImage-magic checked) — see
  `mirror/README.md` for refresh instructions and sizes. (2) Don't run
  `pkill -f serve.mjs` inside a command whose own text contains "serve.mjs" — it
  matches and kills its own shell (silent no-op). Next: Task 3 (per-OS "loads a
  page", still mouse-blocked) or Task 6 (UX polish) or more browsers (Task 4).
- 2026-06-17 — **worker (run: resilience)**: claimed **Task 5** (resilience —
  mirror the small critical images so a copy.sh outage can't take the site/gate
  down). Rationale over queue-top Task 3: the deploy gate (`@smoke`) currently
  boots KolibriOS *from copy.sh*, so a copy.sh outage **blocks deploys** AND breaks
  the flagship live — a real single point of failure that's high-value + low-risk
  to fix; Task 3's GUI automation is still blocked by the relative-mouse gotcha.
  Verified `kolibri.img` (1474560 B, valid KOLIBRI boot sector) and
  `buildroot-bzimage.bin` (5166352 B, real Linux 5.6.15 bzImage) download from
  copy.sh with no Referer (200 + ACAO:* + Accept-Ranges). Self-hosting both in the
  repo `mirror/` (served same-origin by Pages/serve.mjs), wiring a per-image
  `mirror` field so the flagship + the `@smoke` gate + the `@network` proof no
  longer depend on copy.sh; adding a `@cdn` test that still boots kolibri from
  copy.sh to catch hotlink regressions.
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
