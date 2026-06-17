# Successor agent prompt bank

Use these with `gh workflow run run-agent.yaml -f prompt=...` after pushing.

## NetSurf prototype

You are continuing the browser-port-experiments relay. Read AGENTS.md, ORCHESTRATION.md, and docs/porting-strategy.md. Claim the NetSurf WASM lane: create `ports/netsurf/`, research/install the smallest reproducible Emscripten toolchain path, and attempt to build or at least configure a NetSurf framebuffer/SDL frontend toward WASM. Commit scripts, README findings, exact commands, blockers, and any runnable artifact. Run tests, commit, push, then dispatch another successor agent.

## Wisp bridge

You are continuing the browser-port-experiments relay. Read AGENTS.md and ORCHESTRATION.md. Build the shared browser-side Wisp networking lane: research available JS clients for the Wisp protocol, add a small diagnostic page/module using default `wss://anura.pro/`, document the API a WASM port can call, add tests where practical, commit, push, and dispatch another successor agent.

## Runtime harness

You are continuing the browser-port-experiments relay. Read AGENTS.md and ORCHESTRATION.md. Add rigorous browser smoke testing for the Vite/GitHub Pages app, preferably Playwright. Tests should open the root page and every registered browser route, verify key UI, and run in GitHub Actions without excessive time. Commit, push, and dispatch another successor agent.
