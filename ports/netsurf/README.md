# NetSurf framebuffer WASM lane

This lane has a reproducible NetSurf framebuffer build plus a browser-visible libnsfb RAM-surface canvas bridge.

## Current artifact

Checked in:

- `ports/netsurf/artifacts/nsfb.js`
- `ports/netsurf/artifacts/nsfb.wasm`
- `ports/netsurf/artifacts/nsfb-canvas-probe.js`
- `ports/netsurf/artifacts/nsfb-canvas-probe.wasm`
- `public/browsers/netsurf/index.html`
- `public/browsers/netsurf/nsfb.js`
- `public/browsers/netsurf/nsfb.wasm`
- `public/browsers/netsurf/nsfb-canvas-probe.js`
- `public/browsers/netsurf/nsfb-canvas-probe.wasm`

What it proves:

- NetSurf's build tools and core libraries can be cross-built to `wasm32-unknown-emscripten` with Ubuntu/Debian Emscripten 3.1.6.
- The framebuffer target can compile and link as a JS/WASM artifact using the `ram` libnsfb surface.
- The full `nsfb.js` artifact can be loaded from a Vite/GitHub Pages page and reaches Emscripten runtime startup.
- A small `ports/netsurf/canvas-probe.c` harness can initialise a libnsfb RAM surface, draw into it, export pointer/width/height/stride, and copy those pixels into Canvas `ImageData` from `public/browsers/netsurf/`.
- The checked-in artifacts are intentionally offline: curl/networking, OpenSSL, JavaScript/Duktape, PNG/JPEG/WebP/JPEGXL, SVG, and freetype are disabled.

What it does **not** prove yet:

- The visible canvas pixels are from the libnsfb RAM-surface harness, not yet from the full NetSurf browser window. The checked-in `nsfb.js` executable still starts as the offline framebuffer build using `NETSURF_FB_FRONTEND := ram`.
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
sudo apt-get install -y emscripten make gcc g++ pkg-config perl flex bison gperf python3 libpng-dev
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

emcc ports/netsurf/canvas-probe.c \
  -Wl,--whole-archive "$PREFIX/lib/libnsfb.a" -Wl,--no-whole-archive \
  -I"$PREFIX/include" --no-entry -sMODULARIZE=1 \
  -sEXPORT_NAME=createNsfbCanvasProbe
```

## Blockers and local patches

1. **Toolchain detection:** NetSurf buildsystem does not recognise Debian `emcc --version` because it begins with `emcc`, not `clang`. One script creates wrappers that return clang-like `--version` output and the correct `-dumpmachine`; the alternate script passes `TOOLCHAIN=clang`/`toolchain=clang` directly.
2. **Debian frozen Emscripten cache:** `/usr/share/emscripten/.emscripten` sets `FROZEN_CACHE = True`, which prevents first-use zlib port population. Work around this with a local mutable cache or by building zlib from source.
3. **libdom XML binding:** `libdom` defaults `WITH_EXPAT_BINDING := yes`; Emscripten sysroot has no expat. Disable expat/libxml for this first HTML-only probe. This also means `libsvgtiny` cannot build yet, so SVG is disabled for NetSurf.
4. **curl disabled header leak:** even with `NETSURF_USE_CURL := NO`, `content/fetch.c` includes `content/fetchers/curl.h`, which includes `<curl/curl.h>`. Use a tiny local source patch/shim to typedef `CURLM` when `WITH_CURL` is absent.
5. **zlib:** `utils/hashtable.c` includes `zlib.h`; provide Emscripten zlib or a source-built wasm zlib.
6. **NetSurf env.sh strict-mode fragility:** current NetSurf `docs/env.sh` references unset variables and probes optional compiler paths; `build-framebuffer-wasm.sh` relaxes `-e/-u` while sourcing it and leaves `nounset` off for the shell functions it defines.
7. **Native PNG tool dependency:** NetSurf's build-time `convert_image` tool includes `<png.h>` even when target PNG decoding is disabled, so Ubuntu builds need `libpng-dev` for the native helper.
8. **Canvas/frontend:** libnsfb's `ram` surface has no browser presentation callback. This relay added a separate exported RAM-surface harness that JS copies to canvas; the next real milestone is wiring the full NetSurf framebuffer frontend to that export path or adding a dedicated `emscripten`/SDL surface.
9. **libnsfb surface registration in static archives:** `NSFB_SURFACE_DEF(ram, ...)` relies on a constructor in `ram.o`. The canvas probe links `libnsfb.a` with `-Wl,--whole-archive` so that constructor is retained; without it `nsfb_new(NSFB_SURFACE_RAM)` returns `NULL` in wasm.

## Verification performed

```bash
ports/netsurf/scripts/build-framebuffer-wasm.sh
ports/netsurf/scripts/verify-artifact.sh
npm test
```

The Playwright smoke test opens `/browser-port-experiments/browsers/netsurf/`, waits for `body[data-netsurf-canvas-visible="true"]`, and samples non-empty canvas pixels.

## Suggested next steps

1. Move from the standalone `canvas-probe.c` harness to full NetSurf pixels:
   - expose the framebuffer frontend's live `nsfb_t` pointer/geometry after `fb_initialise`, or
   - add an `emscripten` libnsfb surface modelled on `ram.c` whose `update` callback copies dirty rects to JS, or
   - investigate the existing SDL1 libnsfb surface with Emscripten's SDL compatibility (`-sUSE_SDL=1`; the current upstream `sdl.c` includes `<SDL/SDL.h>`, not SDL2 headers).
2. Rebuild the full NetSurf artifact with `-sMODULARIZE=1 -sEXPORT_NAME=createNetSurf` so the public page can control startup and failure reporting without global `Module` coupling.
3. Once full NetSurf pixels are exported, switch the Playwright smoke test from the RAM-surface colour probe to asserting the browser chrome/about page renders.
4. Re-enable PNG/JPEG via Emscripten ports or vendored libraries after full-canvas output works.
5. Design a Wisp-backed fetcher before re-enabling HTTP(S); do not bake `wss://anura.pro/` into C code.
