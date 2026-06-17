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

## Verification status

Run `npm test`. Statuses also live in `browsers.json` (`tested` field) and drive
the badge on the landing page.

| id | browser/engine | status | notes |
| --- | --- | --- | --- |
| kolibrios | WebView (+ NetSurf) | ✅ boots | 1024×768 desktop in ~10s; Wisp connects; CI `@smoke` |
| windows98 | Internet Explorer (Trident) | ✅ boots | restores from state; CI `@state` |
| windows2000 | Internet Explorer 5 (Trident) | ⏳ unverified | state 29 MB; should work like win98 |
| windowsme | Internet Explorer (Trident) | ⏳ unverified | state present |
| haiku | WebPositive (WebKit) | ⏳ unverified | state 38 MB; modern engine — high value |
| reactos | IE-compatible shell | ⏳ unverified | virtio NIC, acpi |
| serenityos | Ladybird (LibWeb) | ⏳ unverified | part URL `serenity-v3/0-1048576.img` 404'd — investigate part layout |
| dsl | Dillo + Firefox | ⏳ unverified | 52 MB ISO, boots X from CD-ROM (slow) |
| (buildroot) | — (test harness only) | ✅ network | `@network`: DHCP + `wget http://example.com` over Wisp returns real HTML |

The end-to-end **Wisp networking is proven** (the `@network` test fetches a live
page). Each guest's own browser still needs a per-OS manual/automated check that it
loads a page over Wisp (most guests need their NIC enabled in-OS first).

## Task queue (pick the top unclaimed item)

When you start a task, append a line to the Log with your run id and "claimed".

1. **Verify the unverified browsers boot.** For each `⏳` row, add a boot test
   (extend `tests/boot.spec.mjs`, tag `@state` for state images) and a screenshot
   probe. If it renders a desktop, set `tested: "boots"`. If broken, set
   `tested: "broken"` and write down why. Start with **haiku** (WebKit, high value)
   and **windows2000**.
2. **Fix SerenityOS image streaming.** `serenity-v3/0-1048576.img` 404s. Inspect
   how copy.sh requests its parts (maybe a different chunk size or the alt part
   format `00000000.img`). Try `fixed_chunk_size` variants or `partfile_alt_format`.
3. **Per-OS "loads a page" automation.** Where feasible, script the guest to open
   its browser and load a page over Wisp, asserting on pixels or, better, on serial
   for text browsers. KolibriOS has a CLI; Linux guests can run `links`.
4. **Add more useful browsers.** Candidates with real engines: Windows XP (if a
   state image exists), more Linux images with modern browsers, Arch + a browser.
   Keep images CDN-streamable; don't commit big blobs.
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
