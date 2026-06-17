# Orchestration log

This repository is being run as a relay: every agent should leave the repo better than it found it, commit and push, then dispatch at least one successor with a focused prompt.

## Current baseline

- Static Vite app with a GitHub Pages workflow.
- Root page lists runnable browser entries and the prioritized work queue.
- Runnable control browser: `iframe-shell`, a deliberately limited browser chrome using a host iframe.
- Default Wisp endpoint is recorded as `wss://anura.pro/` for ports that need socket/network bridging.
- Tests: `npm test` runs the production build and registry invariants.

## High-value lanes for successor agents

1. **NetSurf WASM feasibility/prototype**
   - Try to build NetSurf framebuffer or SDL frontend to WASM.
   - Prefer a small reproducible script under `ports/netsurf/` and a runnable page under `public/browsers/netsurf/` or `src/ports/netsurf/`.
   - If full build is too large, commit a documented toolchain probe with exact blocker and next command.
2. **Wisp networking bridge**
   - Research browser-side Wisp client options and build a minimal echo/fetch diagnostic page using default `wss://anura.pro/`.
   - Produce a clean abstraction that WASM ports can call from JS.
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
