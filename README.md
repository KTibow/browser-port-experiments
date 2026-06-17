# Browser Port Experiments

Real, full web browsers running **entirely inside your browser** — no server does
the rendering. Each entry is a complete operating system emulated in WebAssembly,
drawn to a `<canvas>`, and connected to the live internet over the
[Wisp](https://github.com/MercuryWorkshop/wisp-protocol) protocol.

**Live site:** https://kendell.dev/browser-port-experiments/

| Goal (from `AGENTS.md`) | How it's met |
| --- | --- |
| Logic uses WASM | x86 CPU emulated to WebAssembly via [v86](https://github.com/copy/v86) |
| Graphics use canvases | v86 renders the guest framebuffer to a `<canvas>` |
| Networking uses Wisp (default `wss://anura.pro`) | v86's Wisp backend, `relay_url: "wisps://anura.pro/"` |
| Build → GitHub Pages | `docs/deploy-pages-workflow.example.yaml` (owner copies into `.github/workflows/`) |
| Root page links to each browser | generated from `browsers.json` |
| Rigorously tested to actually function | Playwright suite, incl. a real HTTP fetch over Wisp |

## Why v86?

The brief (WASM logic + canvas graphics + Wisp networking) describes v86 exactly.
Instead of porting a single browser engine, we emulate whole operating systems and
run their *native* browsers — so we get real, feature-complete engines:

- **KolibriOS** → WebView (+ NetSurf) — tiny, boots in seconds
- **Windows 95 / 98 / 2000 / ME** → Internet Explorer (Trident/MSHTML)
- **Haiku** → WebPositive (WebKit)
- **ReactOS** → Windows-compatible shell
- **SerenityOS** → Ladybird (independent LibWeb engine)
- **9front** (Plan 9 fork) → Mothra + NetSurf
- **Redox OS** (modern Rust microkernel + Orbital GUI) → NetSurf
- **SliTaz GNU/Linux** → Midori + TazWeb (WebKitGTK)
- **Android 4.4 (KitKat)** → AOSP Browser (WebKit)
- **Damn Small Linux** → Dillo + Firefox

OS images are streamed on demand from copy.sh's CDN (`i.copy.sh`, the same host
that powers the real v86 demo). For resilience, the two *small, critical* images
are also **self-hosted** in this repo under `mirror/` (the flagship KolibriOS
floppy and the Buildroot kernel used by the networking test), so a copy.sh outage
can't block deploys or break the flagship. See `PLAN.md` for the architecture
decisions, verification status, and the task queue for ongoing work.

## How it works

```
browsers.json   ── registry (single source of truth): per-OS v86 config
src/run.html    ── runner page; sets Referrer-Policy: no-referrer (CDN hotlink)
src/runner.js   ── reads ?os=, builds the V86 config, wires Wisp + controls
vendor/         ── v86 runtime (libv86.mjs + v86.wasm) and SeaBIOS/VGABIOS
scripts/build.mjs ── assembles dist/ and generates index.html from the registry
```

Networking path: guest NIC → v86 (handles DHCP/DNS-over-HTTPS/ARP locally, wraps
TCP in Wisp) → `wss://anura.pro` → the real internet.

The runner also shows a **loading progress bar** while the OS image / saved state
streams in (helpful for the multi-hundred-MB images), and a **Wisp relay picker**
so you can switch relays (default `anura.pro`, plus `wisp.mercurywork.shop` or a
custom one) if the default is blocked — it reloads with `?relay_url=`.

It's also **usable on touch devices**: drag to move the guest cursor (trackpad
style), **tap to left-click**, **long-press to right-click**, and tap the
**⌨ Keyboard** button to pop the on-screen keyboard (keys are forwarded straight
to the guest).

## Develop locally

```bash
npm install
npm run build          # -> dist/
npm run serve          # http://localhost:8000
npm run test:install   # one-time: download the Playwright browser
npm test               # full functional suite (boots + real Wisp fetch)
npx playwright test --grep @smoke   # quick: landing + KolibriOS boot
```

> Note: image loads only work from origins the CDN allows (empty Referer). The
> runner sets `<meta name="referrer" content="no-referrer">`; the local dev server
> mirrors GitHub Pages headers. Loading `dist/` via `file://` will **not** work.

## Add a browser

1. Find a v86-bootable OS that ships a browser (see the profile list in
   [`copy/v86`'s `src/browser/main.js`](https://github.com/copy/v86/blob/master/src/browser/main.js)).
2. Add an entry to `browsers.json` with its `config` (disk/state/memory). Image
   `url`s are relative to the CDN host; the runner prepends it.
3. Use `net_device_type: "ne2k"` unless the image is built for virtio (e.g. ReactOS).
4. Verify with a probe/test, set `tested`, commit, push.

## Tests

- `@smoke` — landing page + KolibriOS graphical boot from the **self-hosted**
  mirror (no third-party deps; gates deploy)
- `@cdn` — KolibriOS still boots streaming from copy.sh (hotlink regression guard)
- `@state` — saved-state OSes resume a booted desktop (Win95/98/2000/ME, Haiku,
  ReactOS, SerenityOS, 9front; and Redox, which auto-logs-in via `autokeys` to
  its Orbital desktop)
- `@cdrom` — Damn Small Linux boots its live CD into the X11 desktop
- `@livecd` — SliTaz live-boots to its graphical Openbox desktop (Midori/WebKit)
- `@slow` — Android 4.4 boots to the launcher (~4-5 min; streams ~250 MB)
- `@network` — boots Linux, DHCP, and `wget`s a live page over Wisp
- `@browse` — a **real browser engine renders a live page over Wisp**: boots
  Linux with a static `links` text browser overlaid via an initrd, then
  `links -dump`s example.com over both HTTP and HTTPS and asserts on the
  *rendered* (tag-free) text
- `@ux` — the loading progress bar and the Wisp relay picker (offline/deterministic)
- `@touch` — mobile/touch input: tap = click, long-press = right-click, drag =
  move, and the on-screen keyboard forwards keys (boots KolibriOS, asserts on the
  v86 input bus)

`node scripts/probe.mjs <osId>` boots a single OS and saves a screenshot to
`/tmp/probe-shots/` — handy for eyeballing a new image (needs `npm run serve`).
`node scripts/watch.mjs <osId> [totalMs] [shotEveryMs]` logs a full boot timeline
with interval screenshots — useful for slow guests (SliTaz, Android) that pass
through boot menus before the real desktop.

## Deployment note

This environment forbids agents from creating `.github/workflows/` files, and the
Pages site uses `build_type: workflow`. The deploy workflow is therefore provided
at `docs/deploy-pages-workflow.example.yaml` for the **repo owner to copy** into
`.github/workflows/deploy-pages.yaml` (same convention as before). Until then the
live URL still shows the previous attempt. See `PLAN.md` for details.

See `PLAN.md` for the current status and what to work on next.
