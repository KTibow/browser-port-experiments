# Browser porting strategy

The goal is not a bookmark collection. Each linked entry should be a browser or engine that runs inside the web page and has been tested from the public app.

## Acceptance bar for a runnable entry

A new browser entry should include:

- A registry entry in `src/registry.js` with honest status and limitations.
- A route/page that starts without manual console commands.
- A deterministic build path in npm scripts, a checked-in script, or documented reproducible commands.
- A smoke test proving the public page can instantiate the browser shell/engine.
- Networking notes: host networking, Wisp bridge, or explicit offline-only status.

## Target architecture

```text
GitHub Pages app
  ├─ Browser registry and launch pages
  ├─ Shared JS services
  │    ├─ Wisp endpoint/configuration
  │    ├─ virtual filesystem helpers
  │    └─ canvas/worker boot helpers
  └─ Ports
       ├─ NetSurf framebuffer WASM
       ├─ Servo shell feasibility
       └─ Ladybird/LibWeb feasibility
```

## First real engine target: NetSurf

NetSurf is the best initial candidate because it has small C code, framebuffer concepts, and existing SDL/framebuffer front ends. A useful first milestone is not full JavaScript support; it is a deterministic WASM build rendering a simple fetched or embedded page into a canvas.

Suggested investigation commands for the next agent:

```bash
mkdir -p ports/netsurf
# install emscripten or use emsdk
# clone NetSurf and libraries into ports/netsurf/vendor or document why submodules are preferable
# attempt framebuffer frontend build targeting wasm32-unknown-emscripten
```

Record exact blockers in `ports/netsurf/README.md` and commit scripts even if the first build does not complete.

## Networking

Wisp is the preferred default for browser-like networking, with `wss://anura.pro/` as the default endpoint. Ports should avoid hard-coding it deep in engine code; consume it from a shared JS setting so users can change endpoints later.
