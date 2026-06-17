# NetSurf framebuffer WASM lane

This lane has a reproducible NetSurf framebuffer build whose live `nsfb_t` surface is presented in an HTML canvas via a libnsfb Emscripten dirty-rect callback.

## Current artifact

Checked in:

- `ports/netsurf/artifacts/nsfb.js`
- `ports/netsurf/artifacts/nsfb.wasm`
- `public/browsers/netsurf/index.html`
- `public/browsers/netsurf/nsfb.js`
- `public/browsers/netsurf/nsfb.wasm`

What it proves:

- NetSurf's build tools and core libraries can be cross-built to `wasm32-unknown-emscripten` with Ubuntu/Debian Emscripten 3.1.6.
- The framebuffer target can compile and link as a JS/WASM artifact using a local `emscripten` libnsfb surface patched into the build.
- The full `nsfb.js` artifact is modularized as `createNetSurfFrameBuffer`, starts from the public page, enters an Emscripten browser main loop, and exports its live framebuffer pointer/width/height/stride plus input queue shims.
- The public page copies NetSurf framebuffer frontend pixels (currently `-f emscripten -w 640 -h 480 about:blank`) into Canvas `ImageData` from libnsfb surface `update` dirty rectangles, coalesces callback bursts to one `requestAnimationFrame` paint, and stamps canvas/body dirty-rect metadata for smoke tests.
- Canvas pointer movement/buttons, wheel, and a broader SDL/libnsfb-style keyboard subset (navigation, modifiers, function keys, numpad fallbacks, printable Latin-1) are queued into libnsfb events for the framebuffer frontend/fbtk path.
- The Emscripten filesystem now embeds `/netsurf` resources (`Messages`, `Choices`, default/internal/quirks/adblock CSS, welcome/credits/licence HTML, `netsurf.png`, `user.css`, and the core icons used by `resource:` fetches). The public page probes those files through exported `FS`, starts `about:welcome`, and the smoke test asserts recognizable English NetSurf chrome/about-page strings plus no missing-message/resource startup log.
- The checked-in artifacts are intentionally offline: curl/networking, OpenSSL, JavaScript/Duktape, PNG/JPEG/WebP/JPEGXL, SVG, and freetype are disabled.

What it does **not** prove yet:

- No Wisp networking yet. HTTP(S) is disabled to avoid libcurl/OpenSSL while the framebuffer path is being established. The public page only documents the future `BrowserPortWisp` handoff and deliberately does not hard-code a Wisp endpoint into HTML or C/WASM.
- Input is now wired at the libnsfb event level with deterministic Playwright coverage for click, wheel, and key forwarding; text composition/IME and exhaustive keycode coverage are not done.
- The page no longer polls/copies the full framebuffer each animation frame; it depends on the dedicated Emscripten libnsfb surface `update` callback. The checked-in artifacts have been rebuilt from the externalized surface source patch and include cursor callbacks plus C-side dirty-rect coalescing; the checked-in page also coalesces dirty callbacks before canvas painting.

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

### Relay script

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

This alternate script clones pinned source revisions under `ports/netsurf/vendor/`, installs NetSurf's buildsystem under `ports/netsurf/inst/`, writes logs to `ports/netsurf/build-logs/`, and copies the runnable artifact to `public/browsers/netsurf/`. Prefer `scripts/build-framebuffer-wasm.sh` for the current full-framebuffer browser page because it carries the newest Emscripten main-loop/framebuffer export patch.

## Exact successful build shape

The current relay script:

1. Creates `wasm32-unknown-emscripten-*` wrappers around `emcc`/`em++`/`emar`/`emranlib` for NetSurf buildsystem detection.
2. Sources NetSurf `docs/env.sh`, clones the NetSurf dependency set, disables libdom XML bindings, and builds static wasm libraries.
3. Assembles an embed directory for `/netsurf` with framebuffer/common resources, generates an English framebuffer `Messages` file from `FatMessages`, writes a minimal offline `Choices`, and leaves Wisp/networking disabled.
4. Writes `netsurf/Makefile.config` with networking and heavyweight image/JS dependencies disabled, `NETSURF_USE_LIBICONV_PLUG := YES`, `/netsurf` as the framebuffer resource path, and modular Emscripten linker flags including `--embed-file ...@/netsurf` and exported `FS`.
5. Patches `content/fetchers/curl.h` so curl-disabled builds do not need `<curl/curl.h>`.
6. Patches libnsfb to add `NSFB_SURFACE_EMSCRIPTEN`, `src/surface/emscripten.c`, and surface makefile wiring. The C surface source lives in `ports/netsurf/patches/libnsfb-emscripten-surface.c`; it owns RAM-like framebuffer storage, coalesces dirty rectangles before calling JS `Module.netsurfOnFramebufferUpdate(...)`, emits `Module.netsurfOnCursorUpdate(...)`, and exposes `netsurf_framebuffer_push_key/mouse/motion` event queue shims.
7. Patches `frontends/framebuffer/framebuffer.c` to export `netsurf_framebuffer_ptr/width/height/stride` for geometry/debugging and dirty-rect copy source pointers.
8. Patches `frontends/framebuffer/gui.c` to run `framebuffer_run_iteration` from `emscripten_set_main_loop` and export `netsurf_framebuffer_main` with the current fixed offline arguments (`about:welcome`).
9. Links the full framebuffer frontend with normal pkg-config libraries intact. Do **not** pass `LDFLAGS=...` on the make command line; that overrides NetSurf's accumulated `-lnsfb`, `-lcss`, `-ldom`, etc. The script appends Emscripten flags in `Makefile.config` instead.

## Blockers and local patches

1. **Toolchain detection:** NetSurf buildsystem does not recognise Debian `emcc --version` because it begins with `emcc`, not `clang`. The relay script creates wrappers that return clang-like `--version` output and the correct `-dumpmachine`.
2. **Debian frozen Emscripten cache:** `/usr/share/emscripten/.emscripten` sets `FROZEN_CACHE = True`, which prevents first-use zlib port population. Work around this with a local mutable cache or by building zlib from source.
3. **libdom XML binding:** `libdom` defaults `WITH_EXPAT_BINDING := yes`; Emscripten sysroot has no expat. Disable expat/libxml for this first HTML-only probe. This also means `libsvgtiny` cannot build yet, so SVG is disabled for NetSurf.
4. **curl disabled header leak:** even with `NETSURF_USE_CURL := NO`, `content/fetch.c` includes `content/fetchers/curl.h`, which includes `<curl/curl.h>`. Use a tiny local source patch/shim to typedef `CURLM` when `WITH_CURL` is absent.
5. **zlib:** `utils/hashtable.c` includes `zlib.h`; provide Emscripten zlib or a source-built wasm zlib.
6. **NetSurf env.sh strict-mode fragility:** current NetSurf `docs/env.sh` references unset variables and probes optional compiler paths; `build-framebuffer-wasm.sh` relaxes `-e/-u` while sourcing it and leaves `nounset` off for the shell functions it defines.
7. **Native PNG tool dependency:** NetSurf's build-time `convert_image` tool includes `<png.h>` even when target PNG decoding is disabled, so Ubuntu builds need `libpng-dev` for the native helper.
8. **Canvas/frontend:** the custom libnsfb `emscripten` surface is patched into libnsfb during the build from `ports/netsurf/patches/libnsfb-emscripten-surface.c`. It extends libnsfb's fixed surface enum, mirrors `ram.c` allocation, coalesces `nsfb_update` dirty rectangles for JS, and has a cursor callback hook. The checked-in HTML also batches dirty callbacks to a single canvas paint per animation frame. The SDL1/Emscripten route remains worth validating later, but the dedicated surface is now the active checked-in path.
9. **libnsfb surface registration in static archives:** `NSFB_SURFACE_DEF(emscripten, ...)` relies on a constructor in `emscripten.o`; the framebuffer frontend Makefile links libnsfb with `-Wl,--whole-archive` so that constructor is retained.

## Verification performed

```bash
ports/netsurf/scripts/build-framebuffer-wasm.sh
ports/netsurf/scripts/verify-artifact.sh
npm test
```

The Playwright smoke test opens `/browser-port-experiments/browsers/netsurf/`, waits for `body[data-netsurf-framebuffer-visible="true"]`, asserts that dirty-rect callback/paint accounting is consistent, verifies deterministic libnsfb cursor metadata, probes embedded `/netsurf` resources for English `Messages` and `about:welcome` text, asserts deterministic raster glyph signatures for the visible toolbar/address chrome and the `about:welcome` heading/body line bands, asserts the startup log has no missing translation/resource messages, samples deterministic NetSurf chrome/content pixels, and performs a deterministic click/wheel/key sequence that must advance the libnsfb/fbtk input queue metadata.

## Suggested next steps

1. Expand visible raster assertions to more chrome/about regions (for example blue link glyphs, icon bitmaps, and scroll-dependent text) beyond the current deterministic toolbar/address/heading/body glyph signatures.
2. Expand canvas input coverage (IME/text input, modifier state, more keycodes) and identify additional deterministic UI interactions beyond the current click/wheel/key/cursor metadata coverage.
3. Re-enable PNG/JPEG via Emscripten ports or vendored libraries after the dirty-rect path remains stable.
4. Design a Wisp-backed fetcher before re-enabling HTTP(S); do not bake `wss://anura.pro/` into C code.
