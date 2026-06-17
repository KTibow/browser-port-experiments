# NetSurf framebuffer WASM lane

This lane now has a reproducible first NetSurf framebuffer build that reaches a linked Emscripten artifact.

## Current artifact

Checked in:

- `ports/netsurf/artifacts/nsfb.js`
- `ports/netsurf/artifacts/nsfb.wasm`
- `public/browsers/netsurf/index.html`
- `public/browsers/netsurf/nsfb.js`
- `public/browsers/netsurf/nsfb.wasm`

What it proves:

- NetSurf's build tools and core libraries can be cross-built to `wasm32-unknown-emscripten` with Debian/Ubuntu Emscripten 3.1.6.
- The framebuffer target can compile and link as a JS/WASM artifact using the `ram` libnsfb surface.
- The checked-in artifact is intentionally offline: curl/networking, OpenSSL, JavaScript/Duktape, PNG/JPEG/WebP/JPEGXL, SVG, and freetype are disabled.

What it does **not** prove yet:

- No canvas presentation yet. The current `NETSURF_FB_FRONTEND := ram` surface is an in-memory framebuffer, not an HTML canvas or SDL surface.
- No Wisp networking yet. HTTP(S) is disabled to avoid libcurl/OpenSSL while the framebuffer/link path is being established.
- The artifact is a probe, not a useful full browser entry. It should not be treated as meeting the repository's runnable-browser acceptance bar yet.

## Rebuild

On Ubuntu 24.04 / GitHub Actions:

```bash
sudo apt-get update
sudo apt-get install -y emscripten make gcc g++ pkg-config perl flex bison gperf python3
ports/netsurf/scripts/build-framebuffer-wasm.sh
ports/netsurf/scripts/verify-artifact.sh
```

By default the script builds in `ports/netsurf/work/` and copies the resulting files to `ports/netsurf/artifacts/` and `public/browsers/netsurf/`. To remove generated work state:

```bash
ports/netsurf/scripts/build-framebuffer-wasm.sh clean
```

Useful overrides:

```bash
NETSURF_WASM_WORK=/tmp/netsurf-wasm-probe ports/netsurf/scripts/build-framebuffer-wasm.sh
JOBS=4 ports/netsurf/scripts/build-framebuffer-wasm.sh
```

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

1. **Toolchain detection:** NetSurf buildsystem does not recognise Debian `emcc --version` because it begins with `emcc`, not `clang`. The script creates wrappers that return clang-like `--version` output and the correct `-dumpmachine`.
2. **Debian frozen Emscripten cache:** `/usr/share/emscripten/.emscripten` sets `FROZEN_CACHE = True`, which prevents first-use zlib port population. The script copies that config into the work dir and flips it to `False`.
3. **libdom XML binding:** `libdom` defaults `WITH_EXPAT_BINDING := yes`; Emscripten sysroot has no expat. The script writes `Makefile.config.override` with expat/libxml disabled. This also means `libsvgtiny` cannot build yet, so SVG is auto-disabled for NetSurf.
4. **curl disabled header leak:** even with `NETSURF_USE_CURL := NO`, `content/fetch.c` includes `content/fetchers/curl.h`, which includes `<curl/curl.h>`. The script applies a tiny local source patch to typedef `CURLM` when `WITH_CURL` is absent.
5. **zlib:** `utils/hashtable.c` includes `zlib.h`; the script primes and links Emscripten's zlib port with `-sUSE_ZLIB`.
6. **Canvas/frontend:** libnsfb's `ram` surface builds. The next real milestone is a browser/canvas-visible surface, probably either a custom libnsfb surface that exports a linear RGBA buffer to JS or an SDL2 surface using Emscripten canvas support.

## Suggested next steps

1. Replace `NETSURF_FB_FRONTEND := ram` with a browser-visible surface:
   - investigate `libnsfb/src/surface/*`, especially `ram.c`, and add an `emscripten` surface, or
   - try `NETSURF_FB_FRONTEND := sdl` with Emscripten SDL2 (`-sUSE_SDL=2`) if NetSurf/libnsfb can use the SDL backend cleanly.
2. Rebuild with `-sMODULARIZE=1 -sEXPORT_NAME=createNetSurf` so the public page can control startup and failure reporting without global `Module` coupling.
3. Export framebuffer pointer/width/height or wire the SDL canvas, then add a Playwright smoke test that sees non-empty pixels.
4. Re-enable PNG/JPEG via Emscripten ports or vendored libraries after canvas output works.
5. Design a Wisp-backed fetcher before re-enabling HTTP(S); do not bake `wss://anura.pro/` into C code.
