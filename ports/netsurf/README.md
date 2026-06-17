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
- The public page copies NetSurf framebuffer frontend pixels (currently `-f emscripten -w 640 -h 480 about:welcome`) into Canvas `ImageData` from libnsfb surface `update` dirty rectangles, coalesces callback bursts to one `requestAnimationFrame` paint, and stamps canvas/body dirty-rect metadata for smoke tests.
- Canvas pointer movement/buttons, wheel, and a broader SDL/libnsfb-style keyboard subset (navigation, modifiers, function keys, numpad fallbacks, printable Latin-1) are queued into libnsfb events for the framebuffer frontend/fbtk path. The public bridge records bounded input history/modifier metadata, focuses a hidden text-input proxy for browser-generated text entry, forwards trusted Chromium `beforeinput` Latin-1 insertText data as key down/up events, keeps Latin-1 `compositionend` text as a fallback for IME coverage, and suppresses a duplicate `beforeinput insertText` commit when a real-browser-style compositionend fallback has just forwarded the same committed text. The browser smoke coverage now also proves deterministic visible fbtk chrome effects: toolbar Back visibly navigates away from `about:welcome` across chrome/status/content/logo raster signatures and toolbar Forward restores its chrome/status/content/logo raster signatures, clicking the address bar changes its caret/focus raster signature, pressing `x` changes the address text raster signature, trusted browser-generated `beforeinput` Latin-1 text visibly adds another address-bar glyph with dirty-rect advancement, uncommitted trusted CDP IME composition metadata leaves that raster unchanged without premature key forwarding, a committed Latin-1 insertText visibly redraws the address glyphs, a trusted non-Latin insertText commit records zero forwarded characters while leaving the Latin-1-only address raster unchanged, a compositionend-then-beforeinput duplicate commit sequence advances the address raster once while recording suppressed duplicate metadata, Playwright's high-level browser text insertion path forwards a trusted Latin-1 `insertText` with deterministic address-raster and commit-guard metadata, and a trusted native browser clipboard paste forwards Latin-1 `insertFromPaste` through the hidden text proxy while suppressing the host paste shortcut from NetSurf and visibly redrawing the address raster. It also isolates top/wheel/PageDown scrollbar chrome/thumb signatures, deeper bottom-of-viewport about:welcome link/text bands, a top-of-page about:welcome logo-link hover/activation path that visibly rasterizes status-bar URL/loading text while the offline welcome bitmap remains present, a deterministic about:welcome search form reveal/input-hover/button-hover/focus/typing/Backspace/edit-caret/button-submit path with visible field, toolbar-address, content, cursor, and status-bar rasters, an alternate Enter-key search submit path with matching offline status/address/content rasters, a top-visible empty search-button hover/activation path with deterministic offline status/address/content rasters, a top-visible search input hover/focus/type/Enter-submit path with deterministic offline field/status/address/content/logo rasters, a top navigation nslinks path that hovers home/documentation/download links with distinct status-bar URLs and separately activates home/download while preserving offline address/content/nav rasters, stable toolbar Reload/Home click paths that preserve about:welcome chrome/status/content/logo raster hashes, deterministic Back/Forward/Reload/Home toolbar hover hand-cursor rects while preserving toolbar/status rasters, intermediate second-wheel/search-reveal content/link/scrollbar bands, a scroll-revealed about:welcome link hover that visibly rasterizes/restores the framebuffer status-bar URL while reporting NetSurf's hand cursor, and alternate lower scroll-revealed about:welcome link hover/activation paths with deterministic adjacent-link status URLs plus address/content/link-stripe rasters, without weakening the dirty-rect assertions.

- The Emscripten filesystem now embeds `/netsurf` resources (`Messages`, `Choices`, default/internal/quirks/adblock CSS, welcome/credits/licence HTML, `netsurf.png`, `user.css`, and the core icons used by `resource:` fetches). The public page probes those files through exported `FS`, starts `about:welcome`, and the smoke test asserts recognizable English NetSurf chrome/about-page strings plus no missing-message/resource startup log.
- The checked-in artifacts are intentionally offline: curl/networking, OpenSSL, JavaScript/Duktape, PNG/JPEG/WebP/JPEGXL, SVG, and freetype are disabled.

What it does **not** prove yet:

- No Wisp networking yet. HTTP(S) is disabled to avoid libcurl/OpenSSL while the framebuffer path is being established. The public page only documents the future `BrowserPortWisp` handoff and deliberately does not hard-code a Wisp endpoint into HTML or C/WASM.
- Input is now wired at the libnsfb event level with deterministic Playwright coverage for click, wheel, key forwarding, visible address-bar caret/focus and typed-text redraws, visible trusted browser-generated `beforeinput` Latin-1 insertText redraws, right-modifier/function/navigation/numpad mappings, trusted browser-generated `beforeinput` Latin-1 insertText forwarding, synthetic Latin-1 composition fallback, a real-browser-style duplicate composition commit guard, Playwright high-level browser `keyboard.insertText` Latin-1 coverage, trusted native clipboard paste `insertFromPaste` Latin-1 forwarding with host-shortcut suppression, visible top-level about:welcome search input keyboard typing/submission, and delivered/drop counters proving the fbtk loop consumes queued events. Full OS/browser IME coverage across native platform input methods and exhaustive keycode coverage are not done, but trusted Chromium CDP compositionstart/update and commit metadata are now covered in addition to the synthetic compositionend fallback, including visible proof that uncommitted composition text does not alter the address bar before a committed Latin-1 insertText redraws it, that a trusted non-Latin insertText commit is recorded without unsupported libnsfb key forwarding or address-raster changes, and that a following duplicate insertText can be suppressed after the compositionend fallback.
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
6. Patches libnsfb to add `NSFB_SURFACE_EMSCRIPTEN`, `src/surface/emscripten.c`, and surface makefile wiring. The C surface source lives in `ports/netsurf/patches/libnsfb-emscripten-surface.c`; it owns RAM-like framebuffer storage, coalesces dirty rectangles before calling JS `Module.netsurfOnFramebufferUpdate(...)`, emits `Module.netsurfOnCursorUpdate(...)`, and exposes `netsurf_framebuffer_push_key/mouse/motion` event queue shims plus pending/delivered/dropped counters.
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

The Playwright smoke test opens `/browser-port-experiments/browsers/netsurf/`, waits for `body[data-netsurf-framebuffer-visible="true"]`, asserts that dirty-rect callback/paint accounting is consistent, verifies deterministic libnsfb cursor metadata, probes embedded `/netsurf` resources for English `Messages` and `about:welcome` text, asserts deterministic raster glyph signatures for the visible toolbar/address chrome and the `about:welcome` heading/body line bands, asserts deterministic visible bitmap signatures for toolbar icon colors and the blue NetSurf about:welcome logo, asserts the startup log has no missing translation/resource messages, samples deterministic NetSurf chrome/content pixels, proves toolbar Back visibly changes the toolbar/address/status/content/logo rasters, toolbar Forward restores the about:welcome status/content/logo/chrome signatures with dirty-rect advancement, toolbar Reload/Home clicks preserve deterministic about:welcome chrome/status/content/logo hashes while still advancing input/dirty-rect metadata, and Back/Forward/Reload/Home toolbar hovers expose deterministic hand-cursor rects while preserving toolbar/status rasters, verifies top-of-page about:welcome logo-link hover and activation status-bar rasters while the offline logo bitmap remains visible, verifies a top-visible about:welcome empty search-button hover and activation path with deterministic offline status/address/content rasters, verifies a top-visible about:welcome search input hover/focus/type/Enter-submit path with deterministic offline field/status/address/content/logo rasters, verifies top navigation about:welcome home/documentation/download link hovers with distinct status-bar targets plus separate home/download offline activations preserving address/content/nav rasters, verifies a scrolled about:welcome search form through visible field/button hover, focus, typed text, Backspace deletion, ArrowLeft/ArrowRight caret movement, button submit status/address/content rasters plus intermediate second-wheel content/link/scrollbar bands, verifies alternate lower scroll-revealed about:welcome link hovers plus activation with deterministic offline status/address/content/link-stripe rasters, and an alternate Enter submit with matching offline rasters, proves address-bar hit testing plus visible fbtk caret/focus and typed-text raster changes after click/keypress, verifies trusted browser-generated Chromium `beforeinput` Latin-1 text forwarding through the hidden input proxy with deterministic visible address glyph and dirty-rect advancement, verifies trusted Chromium CDP IME composition metadata is tracked without premature forwarding or uncommitted address raster changes before Latin-1 commit forwarding visibly redraws the address bar, verifies a trusted non-Latin Chromium insertText commit is recorded without unsupported key forwarding or address-raster changes, verifies a real-browser-style duplicate compositionend/beforeinput commit path forwards the fallback text once and suppresses the duplicate insertText metadata, verifies Playwright high-level browser `keyboard.insertText` Latin-1 forwarding with deterministic visible address-glyph and commit-guard metadata, verifies trusted native clipboard paste forwards a Latin-1 `insertFromPaste` event without leaking the host paste shortcut into NetSurf and visibly redraws the address raster, performs a deterministic click/wheel/key sequence that must advance the libnsfb/fbtk input queue metadata and delivered-event counter without drops, verifies wheel-scrolled blue link glyph regions, lower-page text, bottom-of-viewport link bands, scrollbar chrome/thumb movement, and status-bar URL rasterization/restoration on a scroll-revealed about:welcome link hover while requiring dirty-rect advancement, then verifies expanded input history for right Control, F5, PageDown, NumpadAdd, and Latin-1 `compositionend` fallback characters plus PageDown-scrolled blue link/lower-page/bottom-viewport glyph regions and scrollbar position, verifies upward-wheel back-to-top restoration of the original about:welcome logo/intro glyph regions plus the scrollbar with additional dirty-rect advancement, and finally repeats wheel+PageDown scrolling before verifying keyboard PageUp back-to-top restoration with dirty-rect, scrollbar, and key metadata assertions.

## Suggested next steps

1. Continue expanding visible raster assertions beyond the current toolbar/address/heading/body glyph signatures, toolbar/about-logo bitmap signatures, toolbar Back status/content/logo visible navigation path, toolbar Forward status/content/logo restoration, stable toolbar Reload/Home about:welcome chrome/status/content/logo preservation, deterministic Back/Forward/Reload/Home toolbar hover hand-cursor rects with stable toolbar/status rasters, logo-link hover/activation status-bar rasterization, wheel/PageDown scroll-dependent blue-link/lower-page/bottom-viewport regions, intermediate second-wheel/search-reveal content/link/scrollbar bands, top-visible empty search-button hover/activation coverage, top-visible search input hover/focus/type/Enter-submit coverage, top navigation home/documentation/download link hover/activation coverage with distinct status targets, search form focus/typing/Backspace/edit-caret/button-submit plus Enter-submit coverage, link-hover status-bar rasterization/restoration plus alternate lower-link hovers/activation, isolated scrollbar top/wheel/PageDown positions, upward-wheel back-to-top restoration, and keyboard PageUp restoration after renewed scrolling (for example additional about-page sections, form controls, or more navigation paths).
2. Expand canvas input coverage beyond the current trusted Chromium `beforeinput` insertText check, CDP-driven trusted compositionstart/update/Latin-1 commit/non-Latin zero-forwarding check, real-browser-style duplicate commit guard, Playwright high-level `keyboard.insertText` Latin-1 check, trusted native clipboard paste `insertFromPaste` check, and synthetic composition/modifier/keycode checks toward full platform IME composition flows; identify additional deterministic UI interactions beyond the current click/wheel/key/cursor metadata coverage.

3. Re-enable PNG/JPEG via Emscripten ports or vendored libraries after the dirty-rect path remains stable.
4. Design a Wisp-backed fetcher before re-enabling HTTP(S); do not bake `wss://anura.pro/` into C code.
