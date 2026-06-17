# Orchestration log

This repository is being run as a relay: every agent should leave the repo better than it found it, commit and push, then dispatch at least one successor with a focused prompt.

## Current baseline

- Static Vite app with a GitHub Pages workflow.
- Root page lists runnable browser entries and the prioritized work queue.
- Runnable control browser: `iframe-shell`, a deliberately limited browser chrome using a host iframe.
- Default Wisp endpoint is recorded as `wss://anura.pro/` for ports that need socket/network bridging.
- Shared browser-side Wisp bridge lives in `src/wisp-bridge.js`, documented in `docs/wisp-bridge.md`, with a manual diagnostic at `#/wisp` that opens a TCP stream to `example.com:80` through Wisp.
- Tests: `npm test` runs the production build, Playwright browser smoke tests, registry invariants, Wisp bridge unit tests, and a NetSurf public full-framebuffer smoke test.
- NetSurf lane now runs the offline full framebuffer frontend in the browser: `public/browsers/netsurf/nsfb.js/.wasm` exports the live `nsfb_t` RAM surface and the page copies those pixels into canvas. The page exposes `window.netsurfFramebufferState`/`body[data-netsurf-framebuffer-*]` so Playwright asserts the full-frontend RAM surface (not the old canvas probe); the legacy `probe.html` now points to the full framebuffer page.

## High-value lanes for successor agents

1. **NetSurf framebuffer usability follow-through**
   - Replace the current `full-frame-poll` copy with a custom libnsfb `emscripten` surface whose `update` callback sends dirty rects to JS, or validate the SDL1/Emscripten surface route, while preserving the current metadata/test contract.
   - Wire canvas mouse/keyboard input into the framebuffer frontend/fbtk event path.
   - Strengthen the public page and Playwright test to assert deterministic NetSurf about/browser chrome, then start re-enabling image formats and Wisp-backed networking.
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
