# Orchestration log

This repository is being run as a relay: every agent should leave the repo better than it found it, commit and push, then dispatch at least one successor with a focused prompt.

## Current baseline

- Static Vite app with a GitHub Pages workflow.
- Root page lists runnable browser entries and the prioritized work queue.
- Runnable control browser: `iframe-shell`, a deliberately limited browser chrome using a host iframe.
- Default Wisp endpoint is recorded as `wss://anura.pro/` for ports that need socket/network bridging.
- Shared browser-side Wisp bridge lives in `src/wisp-bridge.js`, documented in `docs/wisp-bridge.md`, with a manual diagnostic at `#/wisp` that opens a TCP stream to `example.com:80` through Wisp.
- Tests: `npm test` runs the production build, Playwright browser smoke tests, registry invariants, Wisp bridge unit tests, and a NetSurf public canvas dirty-rect smoke test.
- NetSurf lane now runs the offline full framebuffer frontend in the browser: `public/browsers/netsurf/nsfb.js/.wasm` uses a patched libnsfb `emscripten` surface that owns the live `nsfb_t` framebuffer, calls JS with coalesced dirty rectangles from `nsfb_update`, emits cursor metadata, and queues canvas pointer/wheel/keyboard events back into libnsfb/fbtk with input delivery/drop counters. The C surface patch lives at `ports/netsurf/patches/libnsfb-emscripten-surface.c`, the checked-in WASM artifacts have been rebuilt from it, and the public page additionally coalesces dirty callbacks before canvas painting. The artifacts now embed a `/netsurf` Emscripten filesystem package with English `Messages`, minimal `Choices`, default/internal/quirks/adblock CSS, welcome/credits/licence resources, and core resource icons; startup uses `about:welcome`, probes translated NetSurf chrome/about strings through exported `FS`, and Playwright asserts no missing translation/resource log. Playwright also covers deterministic dirty-rect, cursor, input metadata/delivery, address-bar hit testing/focus/key forwarding, visible address-bar caret focus and typed-text raster changes from fbtk input, trusted browser-generated `beforeinput` Latin-1 text forwarding via a hidden input proxy with visible address-bar glyph redraw, trusted Chromium CDP IME `compositionstart`/`compositionupdate` plus `insertCompositionText` metadata without premature forwarding or uncommitted address-bar raster changes before a committed Latin-1 `insertText` visibly redraws the address glyphs, visible toolbar Back navigation status/content/logo raster changes and Forward status/content/logo restoration, toolbar click forwarding, click/wheel/key forwarding, expanded key/modifier/IME-composition forwarding metadata, visible bitmap signatures for toolbar icons plus the blue NetSurf about:welcome logo, top-of-page about:welcome logo-link hover/activation status-bar raster effects while preserving the offline welcome bitmap, scroll-dependent about:welcome blue link/lower-page glyph regions after wheel and PageDown, deterministic about:welcome search form reveal/input-hover/button-hover/focus/typing/button-submit rasters with cursor and status-bar effects, an alternate Enter-key search submit path with matching offline status/address/content rasters, stable toolbar Reload/Home click forwarding with unchanged about:welcome chrome/status/content/logo raster hashes, deterministic hover over a scroll-revealed about:welcome link with hand-cursor metadata plus visible status-bar URL rasterization/restoration, deeper bottom-of-viewport about:welcome link/text bands, isolated scrollbar chrome/thumb signatures for top/wheel/PageDown positions, upward-wheel back-to-top logo/intro/scrollbar restoration, and an alternate keyboard PageUp back-to-top restoration path after renewed wheel+PageDown scrolling while asserting dirty-rect advancement. The legacy `probe.html` points to the full framebuffer page.

## High-value lanes for successor agents

1. **NetSurf framebuffer usability follow-through**
   - Continue expanding input toward full real browser-generated IME flows and exhaustive keycode coverage beyond the current deterministic synthetic modifier/navigation/numpad/composition assertion, trusted Chromium `beforeinput` Latin-1 text coverage with visible address glyph proof, trusted CDP-driven IME composition metadata/commit coverage with uncommitted/committed address raster assertions, and visible address-bar focus/typed-text raster proof.
   - Continue broadening deterministic visible assertions for the embedded `about:welcome`/translated chrome beyond the current toolbar/address/heading/body glyphs, toolbar/about-logo bitmap hashes, visible toolbar Back status/content/logo navigation path plus Forward status/content/logo restoration, stable toolbar Reload/Home about:welcome chrome/status/content/logo preservation, logo-link hover/activation status-bar raster effects, wheel/PageDown scroll-revealed blue-link/lower-text/bottom-viewport regions, about:welcome search form focus/typing/button-submit plus Enter-submit rasters, link-hover status-bar rasterization/restoration, isolated scrollbar top/wheel/PageDown signatures, upward-wheel back-to-top restoration, and keyboard PageUp restoration after renewed scrolling (for example additional page sections, form controls, or more alternate navigation paths).
   - Start re-enabling image formats and Wisp-backed networking after keeping the current deterministic chrome/about rendering smoke green.
2. **Wisp networking bridge follow-through**
   - Exercise `#/wisp` in a real browser smoke test and adapt the bridge to the first WASM port's C/JS ABI.
   - Consider adding TLS/libcurl.js or CONNECT helpers once a real engine needs HTTPS.
3. **Runtime/test harness**
   - Add Playwright or equivalent browser tests that load the Pages app, open every registered browser, and verify canvas/iframe/worker startup.
   - Keep tests fast enough for GitHub Actions.
4. **Engine scouting**
   - Evaluate Servo and Ladybird for realistic wasm32 builds in this repo.
   - Commit findings as scripts/docs, not just prose; the next agent should be able to continue from the terminal commands.

## Relay protocol

Before finishing:

```bash
npm test
git status --short
git add .
git commit -m "<short useful message>"
git pull --rebase origin main
git push origin HEAD:main
gh workflow run run-agent.yaml -f prompt="<focused successor prompt>"
```

If you cannot push because another agent won the race, rebase, resolve, retest, and push.
