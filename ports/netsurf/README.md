# NetSurf framebuffer WASM lane

This lane has a reproducible first NetSurf framebuffer build that reaches linked Emscripten JS/WASM artifacts.

## Current artifact

Checked in:

- `ports/netsurf/artifacts/nsfb.js`
- `ports/netsurf/artifacts/nsfb.wasm`
- `public/browsers/netsurf/index.html`
- `public/browsers/netsurf/nsfb.js`
- `public/browsers/netsurf/nsfb.wasm`

What it proves:

- NetSurf's build tools and core libraries can be cross-built to `wasm32-unknown-emscripten` with Ubuntu/Debian Emscripten 3.1.6.
- The framebuffer target can compile and link as a JS/WASM artifact using the `ram` libnsfb surface.
- The artifact can be loaded from a Vite/GitHub Pages page and reaches `onRuntimeInitialized`.

What it does **not** prove yet:

- No canvas presentation yet. The current `NETSURF_FB_FRONTEND := ram` surface is an in-memory framebuffer, not an HTML canvas or SDL surface.
- No Wisp networking yet. HTTP(S) is disabled to avoid libcurl/OpenSSL while the framebuffer/link path is being established.
- The artifact is a probe, not a useful full browser entry. It should not be treated as meeting the repository's runnable-browser acceptance bar yet.

## Toolchain path

Smallest reproducible path found on the Ubuntu 24.04 GitHub runner:

```bash
ports/netsurf/install-toolchain-apt.sh
```

That installs Ubuntu's `emscripten` package (`emcc 3.1.6`), plus make/gperf/parser tools. This is operationally smaller than cloning `emsdk`, though the apt package itself installs LLVM/Binaryen.

Important quirk: Ubuntu's Emscripten package has a frozen global cache, so first-use Emscripten ports such as `-sUSE_ZLIB` can fail as an unprivileged user. The checked-in scripts document two ways around that:

- `ports/netsurf/scripts/build-framebuffer-wasm.sh` uses a local Emscripten config/cache and primes zlib.
- `ports/netsurf/build-wasm.sh` clones `madler/zlib` and cross-builds it with `emconfigure`/`emmake`.

## Rebuild options

### Relay script from the first successful push

```bash
sudo apt-get update
sudo apt-get install -y emscripten make gcc g++ pkg-config perl flex bison gperf python3
ports/netsurf/scripts/build-framebuffer-wasm.sh
ports/netsurf/scripts/verify-artifact.sh
```

By default that script builds in `ports/netsurf/work/` and copies the resulting files to `ports/netsurf/artifacts/` and `public/browsers/netsurf/`. To remove generated work state:

```bash
ports/netsurf/scripts/build-framebuffer-wasm.sh clean
```

Useful overrides:

```bash
NETSURF_WASM_WORK=/tmp/netsurf-wasm-probe ports/netsurf/scripts/build-framebuffer-wasm.sh
JOBS=4 ports/netsurf/scripts/build-framebuffer-wasm.sh
```

### Alternate pinned-source script

```bash
# optional if emcc is missing
ports/netsurf/install-toolchain-apt.sh

ports/netsurf/build-wasm.sh
```

This alternate script clones pinned source revisions under `ports/netsurf/vendor/`, installs NetSurf's buildsystem under `ports/netsurf/inst/`, writes logs to `ports/netsurf/build-logs/`, and copies the runnable artifact to `public/browsers/netsurf/`.

Pinned revisions used by that successful build:

| Project | Revision |
| --- | --- |
| buildsystem | `0005ae300283ff01c2e2b05e7376b3e55dea21f7` |
| netsurf | `39da3c3a40af4566d86500ff3052dfdc7f9a0378` |
| libnsutils | `0bd39060740b6163bd50875326654a722df97eb2` |
| libnslog | `bedff2146270a8a73cc265bab46ec39f9c170d07` |
| libnspsl | `82815c2bc7fd70d1b6afccfa89a9a0f3fa73db8a` |
| libnsbmp | `ea063c9f46acb43e90208da14073332b505ef7e7` |
| libnsgif | `5d5d750f32755d415fd232c607e6ef64dcc5aa8a` |
| libparserutils | `6b0cbf086ca8eb8fe74b69f0c9ecf274eb2397ca` |
| libwapcaplet | `c7c128d3eb3223b216c974471f82e9337fbcf4ba` |
| libhubbub | `6651b8cf87a4aa87bcdb2ff024a02659cd3f9402` |
| libcss | `104d87fde48b9e022cd3cdad28aeb4d8cc0a0c5a` |
| libdom | `f69781e1f062444b5af3f62d431d7d94018da53b` |
| libnsfb | `b701cdce7241c3747ccd78658a365db0983ebe24` |
| zlib | `e3dc0a85b7032e98380dec011bc8f2c2ee0d8fca` |

## Exact successful build shape

Validated command sequence during this relay:

```bash
sudo apt-get install -y emscripten pkg-config make gcc g++ perl flex bison gperf \
  libcurl4-openssl-dev libpng-dev libjpeg-dev libwebp-dev libssl-dev

# Script-created compiler wrappers:
#   wasm32-unknown-emscripten-gcc -> emcc
#   wasm32-unknown-emscripten-cc  -> emcc
#   wasm32-unknown-emscripten-g++ -> em++
#   wasm32-unknown-emscripten-ar  -> emar
#   wasm32-unknown-emscripten-ranlib -> emranlib

HOST=wasm32-unknown-emscripten \
TARGET_WORKSPACE=/tmp/netsurf-wasm-probe/workspace \
REPO_BASE_URI=https://github.com/netsurf-browser \
source /tmp/netsurf-wasm-probe/workspace/netsurf/docs/env.sh

ns-clone --shallow -d
ns-make-tools install
printf 'WITH_EXPAT_BINDING := no\nWITH_LIBXML_BINDING := no\n' > libdom/Makefile.config.override
make -C libwapcaplet HOST=wasm32-unknown-emscripten install
# ...repeat for libparserutils libhubbub libdom libcss libnsgif libnsbmp
#    libnsutils libnspsl libnslog libnsfb...

make -C netsurf TARGET=framebuffer HOST=wasm32-unknown-emscripten \
  CC=wasm32-unknown-emscripten-gcc CXX=wasm32-unknown-emscripten-g++ \
  LDFLAGS='-sUSE_ZLIB -sERROR_ON_UNDEFINED_SYMBOLS=0 -sEXPORTED_RUNTIME_METHODS=ccall,cwrap'
```

## Blockers and local patches

1. **Toolchain detection:** NetSurf buildsystem does not recognise Debian `emcc --version` because it begins with `emcc`, not `clang`. One script creates wrappers that return clang-like `--version` output and the correct `-dumpmachine`; the alternate script passes `TOOLCHAIN=clang`/`toolchain=clang` directly.
2. **Debian frozen Emscripten cache:** `/usr/share/emscripten/.emscripten` sets `FROZEN_CACHE = True`, which prevents first-use zlib port population. Work around this with a local mutable cache or by building zlib from source.
3. **libdom XML binding:** `libdom` defaults `WITH_EXPAT_BINDING := yes`; Emscripten sysroot has no expat. Disable expat/libxml for this first HTML-only probe. This also means `libsvgtiny` cannot build yet, so SVG is disabled for NetSurf.
4. **curl disabled header leak:** even with `NETSURF_USE_CURL := NO`, `content/fetch.c` includes `content/fetchers/curl.h`, which includes `<curl/curl.h>`. Use a tiny local source patch/shim to typedef `CURLM` when `WITH_CURL` is absent.
5. **zlib:** `utils/hashtable.c` includes `zlib.h`; provide Emscripten zlib or a source-built wasm zlib.
6. **Canvas/frontend:** libnsfb's `ram` surface builds. The next real milestone is a browser/canvas-visible surface, probably either a custom libnsfb surface that exports a linear RGBA buffer to JS or an SDL2 surface using Emscripten canvas support.

## Verification performed

```bash
ports/netsurf/build-wasm.sh
npm test
# Manual Playwright probe against Vite preview opened:
# /browser-port-experiments/browsers/netsurf/
# Observed status text: "NetSurf WASM runtime initialized"
```

## Suggested next steps

1. Replace `NETSURF_FB_FRONTEND := ram` with a browser-visible surface:
   - investigate `libnsfb/src/surface/*`, especially `ram.c`, and add an `emscripten` surface, or
   - try `NETSURF_FB_FRONTEND := sdl` with Emscripten SDL2 (`-sUSE_SDL=2`) if NetSurf/libnsfb can use the SDL backend cleanly.
2. Rebuild with `-sMODULARIZE=1 -sEXPORT_NAME=createNetSurf` so the public page can control startup and failure reporting without global `Module` coupling.
3. Export framebuffer pointer/width/height or wire the SDL canvas, then add a Playwright smoke test that sees non-empty pixels.
4. Re-enable PNG/JPEG via Emscripten ports or vendored libraries after canvas output works.
5. Design a Wisp-backed fetcher before re-enabling HTTP(S); do not bake `wss://anura.pro/` into C code.
