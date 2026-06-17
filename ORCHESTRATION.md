# Orchestration log

This repository is being run as a relay: every agent should leave the repo better than it found it, commit and push, then dispatch at least one successor with a focused prompt.

## Current baseline

- Static Vite app with a GitHub Pages workflow.
- Root page lists runnable browser entries and the prioritized work queue.
- Runnable control browser: `iframe-shell`, a deliberately limited browser chrome using a host iframe.
- Default Wisp endpoint is recorded as `wss://anura.pro/` for ports that need socket/network bridging.
- Shared browser-side Wisp bridge lives in `src/wisp-bridge.js`, documented in `docs/wisp-bridge.md`, with a manual diagnostic at `#/wisp` that opens a TCP stream to `example.com:80` through Wisp.
- Tests: `npm test` runs the production build, Playwright browser smoke tests, registry invariants, Wisp bridge unit tests, and a NetSurf public canvas dirty-rect smoke test.
- NetSurf lane now runs the offline full framebuffer frontend in the browser: `public/browsers/netsurf/nsfb.js/.wasm` uses a patched libnsfb `emscripten` surface that owns the live `nsfb_t` framebuffer, calls JS with coalesced dirty rectangles from `nsfb_update`, emits cursor metadata, and queues canvas pointer/wheel/keyboard events back into libnsfb/fbtk. The C surface patch lives at `ports/netsurf/patches/libnsfb-emscripten-surface.c`, the checked-in WASM artifacts have been rebuilt from it, and the public page additionally coalesces dirty callbacks before canvas painting. Playwright now covers deterministic dirty-rect, cursor, and input metadata. The legacy `probe.html` points to the full framebuffer page.

## High-value lanes for successor agents

1. **NetSurf framebuffer usability follow-through**
   - Continue expanding input toward text composition/IME and exhaustive keycode coverage beyond the current deterministic click/wheel/key Playwright assertion.
   - Identify a deterministic NetSurf UI action (for example address-bar text editing or toolbar activation) and assert the C event queue has an observable browser-state effect, not only forwarded-event metadata.
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
