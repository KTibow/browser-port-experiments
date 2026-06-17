# Browser Port Experiments

A relay workspace for porting useful browsers and browser engines to run entirely inside the web browser.

## Current runnable app

- Vite static app at the repository root.
- Root page links to registered browser experiments.
- Current working control: **Baseline Iframe Browser Shell** (`#/browser/iframe-shell`). It provides browser chrome and a viewport harness, but honestly uses the host browser iframe and is limited by `X-Frame-Options`/CSP.
- Default Wisp endpoint constant: `wss://anura.pro/`.
- NetSurf WASM lane: `ports/netsurf/` documents and scripts a framebuffer/RAM Emscripten probe, with an inspection artifact at `public/browsers/netsurf/probe.html`.

## Local development

```bash
npm install
npm run dev
npm test
```

## Orchestration

Read `AGENTS.md`, `ORCHESTRATION.md`, and `docs/porting-strategy.md` before taking a lane. Every agent should commit, push, and dispatch at least one successor run.

## Deployment note

A GitHub Pages workflow is still needed under `.github/workflows/` once an actor with `workflow` scope is available. This run could not push workflow changes with the available token, so the app and tests are in place but Pages deployment automation remains a handoff item.
