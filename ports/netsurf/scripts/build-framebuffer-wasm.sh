#!/usr/bin/env bash
set -euo pipefail

# Reproducible NetSurf framebuffer -> wasm32-unknown-emscripten probe.
# This script intentionally builds outside git-tracked source trees by default.
# It was validated on Ubuntu 24.04 GitHub Actions with Debian's emscripten
# package (3.1.6~dfsg-7).

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PORT_DIR="$ROOT_DIR/ports/netsurf"
WORK_DIR="${NETSURF_WASM_WORK:-$PORT_DIR/work}"
WORKSPACE="$WORK_DIR/workspace"
BIN_DIR="$WORK_DIR/bin"
ARTIFACT_DIR="${NETSURF_WASM_ARTIFACTS:-$PORT_DIR/artifacts}"
PUBLIC_DIR="${NETSURF_WASM_PUBLIC:-$ROOT_DIR/public/browsers/netsurf}"
JOBS="${JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)}"
REPO_BASE_URI="${REPO_BASE_URI:-https://github.com/netsurf-browser}"
HOST_TRIPLE="wasm32-unknown-emscripten"

if [[ "${1:-}" == "clean" ]]; then
  rm -rf "$WORK_DIR" "$ARTIFACT_DIR" "$PUBLIC_DIR"
  exit 0
fi

if ! command -v emcc >/dev/null 2>&1; then
  cat >&2 <<'MSG'
emcc was not found. On the GitHub Actions Ubuntu image this probe uses:
  sudo apt-get update
  sudo apt-get install -y emscripten make gcc g++ pkg-config perl flex bison gperf python3 libpng-dev
MSG
  exit 127
fi

mkdir -p "$BIN_DIR" "$WORKSPACE" "$ARTIFACT_DIR" "$PUBLIC_DIR"

# NetSurf's shared buildsystem recognises clang/gcc by the first token printed
# by --version. Debian emcc prints "emcc", so wrap emcc/em++ with a clang-like
# version response while preserving -dumpmachine for env.sh validation.
cat > "$BIN_DIR/$HOST_TRIPLE-gcc" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  --version) echo "clang 15.0.7 (emscripten emcc wrapper)"; exit 0 ;;
  -dumpspecs) exit 1 ;;
  -dumpmachine) echo "wasm32-unknown-emscripten"; exit 0 ;;
esac
exec emcc "$@"
EOF
cp "$BIN_DIR/$HOST_TRIPLE-gcc" "$BIN_DIR/$HOST_TRIPLE-cc"
cat > "$BIN_DIR/$HOST_TRIPLE-g++" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  --version) echo "clang 15.0.7 (emscripten em++ wrapper)"; exit 0 ;;
  -dumpspecs) exit 1 ;;
  -dumpmachine) echo "wasm32-unknown-emscripten"; exit 0 ;;
esac
exec em++ "$@"
EOF
cat > "$BIN_DIR/$HOST_TRIPLE-ar" <<'EOF'
#!/usr/bin/env bash
exec emar "$@"
EOF
cat > "$BIN_DIR/$HOST_TRIPLE-ranlib" <<'EOF'
#!/usr/bin/env bash
exec emranlib "$@"
EOF
chmod +x "$BIN_DIR"/*
export PATH="$BIN_DIR:$PATH"

# Debian's emscripten package ships a frozen root config. Copy it and unfreeze
# so ports such as zlib can be populated in the user's cache.
if [[ -f /usr/share/emscripten/.emscripten ]]; then
  EM_CONFIG_FILE="$WORK_DIR/emscripten-config.py"
  cp /usr/share/emscripten/.emscripten "$EM_CONFIG_FILE"
  python3 - "$EM_CONFIG_FILE" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
s = p.read_text()
s = s.replace('FROZEN_CACHE = True', 'FROZEN_CACHE = False')
p.write_text(s)
PY
  export EM_CONFIG="$EM_CONFIG_FILE"
fi

if [[ ! -d "$WORKSPACE/netsurf/.git" ]]; then
  git clone --depth 1 "$REPO_BASE_URI/netsurf.git" "$WORKSPACE/netsurf"
fi

# shellcheck source=/dev/null
# env.sh probes for optional commands using failing command substitutions and
# references unset variables on current NetSurf HEAD. Temporarily relax -e/-u
# while sourcing it. Keep nounset off afterwards because ns-clone is a shell
# function from env.sh and still references optional unset variables.
export HOST="$HOST_TRIPLE"
export TARGET_WORKSPACE="$WORKSPACE"
export REPO_BASE_URI="$REPO_BASE_URI"
export USE_CPUS="-j$JOBS"
set +eu
source "$WORKSPACE/netsurf/docs/env.sh"
ENV_STATUS=$?
set -eo pipefail
if [[ "$ENV_STATUS" -ne 0 ]]; then
  echo "failed to source NetSurf env.sh" >&2
  exit "$ENV_STATUS"
fi

ns-clone --shallow -d

# Native build tools, then wasm libraries. libdom's XML bindings need expat or
# libxml2; disable them for the first offline/about:data framebuffer milestone.
ns-make-tools install
printf 'WITH_EXPAT_BINDING := no\nWITH_LIBXML_BINDING := no\n' > "$WORKSPACE/libdom/Makefile.config.override"
for repo in \
  buildsystem \
  libwapcaplet libparserutils libhubbub libdom libcss \
  libnsgif libnsbmp libnsutils libnspsl libnslog \
  libnsfb
  do
  echo "    MAKE: make -C $repo install"
  make -C "$WORKSPACE/$repo" HOST="$HOST_TRIPLE" PREFIX="$PREFIX" "-j$JOBS" install
done

cat > "$WORKSPACE/netsurf/Makefile.config" <<'EOF'
override NETSURF_USE_CURL := NO
override NETSURF_USE_OPENSSL := NO
override NETSURF_USE_JPEG := NO
override NETSURF_USE_JPEGXL := NO
override NETSURF_USE_PNG := NO
override NETSURF_USE_WEBP := NO
override NETSURF_USE_DUKTAPE := NO
override NETSURF_USE_LIBICONV_PLUG := NO
override NETSURF_USE_UTF8PROC := NO
override NETSURF_USE_BMP := YES
override NETSURF_USE_GIF := YES
override NETSURF_USE_NSPSL := YES
override NETSURF_USE_NSLOG := YES
override NETSURF_FB_FONTLIB := internal
override NETSURF_FB_FRONTEND := ram
EOF

# With curl disabled, fetch.c still includes this registration header for the
# CURLM declaration. Keep the patch as small and obvious as possible.
python3 - "$WORKSPACE/netsurf/content/fetchers/curl.h" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
s = p.read_text()
old = '#include <curl/curl.h>'
new = '#ifdef WITH_CURL\n#include <curl/curl.h>\n#else\ntypedef void CURLM;\n#endif'
if old in s:
    p.write_text(s.replace(old, new))
PY

# Populate Emscripten's zlib port up front, then link with zlib. NetSurf's
# hashtable utility includes zlib.h even in the offline/curl-disabled build.
emcc -sUSE_ZLIB -x c - -o "$WORK_DIR/zlib-probe.js" >/dev/null 2>&1 <<'EOF'
#include <zlib.h>
int main(void) { return (int)zlibVersion()[0]; }
EOF

make -C "$WORKSPACE/netsurf" \
  TARGET=framebuffer \
  HOST="$HOST_TRIPLE" \
  PREFIX="$PREFIX" \
  CC="$HOST_TRIPLE-gcc" \
  CXX="$HOST_TRIPLE-g++" \
  LDFLAGS='-sUSE_ZLIB -sERROR_ON_UNDEFINED_SYMBOLS=0 -sEXPORTED_RUNTIME_METHODS=ccall,cwrap' \
  "-j$JOBS"

# Browser-visible milestone: export a libnsfb RAM surface as a linear RGBA
# buffer. This is intentionally separate from the NetSurf frontend executable
# until the framebuffer frontend can keep its browser_window/nsfb pointer alive
# for JS (or a dedicated emscripten surface lands in libnsfb).
emcc "$PORT_DIR/canvas-probe.c" \
  -Wl,--whole-archive "$PREFIX/lib/libnsfb.a" -Wl,--no-whole-archive \
  -I"$PREFIX/include" \
  -O2 \
  --no-entry \
  -sMODULARIZE=1 \
  -sEXPORT_NAME=createNsfbCanvasProbe \
  -sENVIRONMENT=web,worker \
  -sALLOW_MEMORY_GROWTH=1 \
  -sEXPORTED_FUNCTIONS='["_netsurf_canvas_probe_init","_netsurf_canvas_probe_render","_netsurf_canvas_probe_ptr","_netsurf_canvas_probe_width","_netsurf_canvas_probe_height","_netsurf_canvas_probe_stride"]' \
  -sEXPORTED_RUNTIME_METHODS='["ccall"]' \
  -o "$ARTIFACT_DIR/nsfb-canvas-probe.js"

cp "$WORKSPACE/netsurf/nsfb" "$ARTIFACT_DIR/nsfb.js"
cp "$WORKSPACE/netsurf/nsfb.wasm" "$ARTIFACT_DIR/nsfb.wasm"
cp "$ARTIFACT_DIR/nsfb.js" "$PUBLIC_DIR/nsfb.js"
cp "$ARTIFACT_DIR/nsfb.wasm" "$PUBLIC_DIR/nsfb.wasm"
cp "$ARTIFACT_DIR/nsfb-canvas-probe.js" "$PUBLIC_DIR/nsfb-canvas-probe.js"
cp "$ARTIFACT_DIR/nsfb-canvas-probe.wasm" "$PUBLIC_DIR/nsfb-canvas-probe.wasm"

cat > "$PUBLIC_DIR/index.html" <<'HTML'
<!doctype html>
<meta charset="utf-8" />
<title>NetSurf framebuffer canvas probe</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font: 15px system-ui, sans-serif; background: #10131a; color: #f3f6fb; }
  main { max-width: 1040px; margin: 0 auto; padding: 24px; }
  canvas { display: block; width: 100%; max-width: 960px; height: auto; image-rendering: pixelated; background: #05070a; border: 1px solid #2b3342; border-radius: 10px; box-shadow: 0 18px 60px #0007; }
  pre { min-height: 7rem; padding: 16px; overflow: auto; background: #05070a; border: 1px solid #2b3342; border-radius: 10px; }
  .note { color: #b8c0cc; line-height: 1.45; }
  .ok { color: #4fd1c5; font-weight: 700; }
</style>
<main>
  <h1>NetSurf framebuffer canvas probe</h1>
  <p class="note">This page now displays pixels from a wasm-built <code>libnsfb</code> RAM surface in an HTML canvas. It is still an offline probe: the full NetSurf framebuffer executable (<code>nsfb.js</code>) is checked in, but the browser page uses a small exported libnsfb surface harness until NetSurf's framebuffer frontend exposes its live surface or gains a dedicated Emscripten surface.</p>
  <canvas id="viewport" width="640" height="360" aria-label="NetSurf libnsfb framebuffer pixels"></canvas>
  <p id="status" class="note">Loading nsfb-canvas-probe.js…</p>
  <pre id="log"></pre>
</main>
<script src="./nsfb-canvas-probe.js"></script>
<script>
  const canvas = document.querySelector('#viewport');
  const status = document.querySelector('#status');
  const log = document.querySelector('#log');
  const ctx = canvas.getContext('2d', { alpha: false });
  const image = ctx.createImageData(canvas.width, canvas.height);

  const appendLog = (line) => { log.textContent += `${line}\n`; };

  function copyFramebufferToCanvas(module) {
    const ptr = module.ccall('netsurf_canvas_probe_ptr', 'number', [], []);
    const width = module.ccall('netsurf_canvas_probe_width', 'number', [], []);
    const height = module.ccall('netsurf_canvas_probe_height', 'number', [], []);
    const stride = module.ccall('netsurf_canvas_probe_stride', 'number', [], []);
    const heap = module.HEAPU8;

    for (let y = 0; y < height; y += 1) {
      const row = heap.subarray(ptr + y * stride, ptr + y * stride + width * 4);
      image.data.set(row, y * width * 4);
    }
    ctx.putImageData(image, 0, 0);
  }

  async function boot() {
    if (typeof createNsfbCanvasProbe !== 'function') {
      throw new Error('createNsfbCanvasProbe was not defined by nsfb-canvas-probe.js');
    }

    const module = await createNsfbCanvasProbe({
      locateFile: (path) => path,
      print: appendLog,
      printErr: (line) => appendLog(`[stderr] ${line}`),
    });

    const initResult = module.ccall('netsurf_canvas_probe_init', 'number', ['number', 'number'], [canvas.width, canvas.height]);
    if (initResult !== 0) {
      throw new Error(`libnsfb RAM surface init failed with code ${initResult}`);
    }

    let tick = 0;
    const render = () => {
      const renderResult = module.ccall('netsurf_canvas_probe_render', 'number', ['number'], [tick]);
      if (renderResult !== 0) {
        throw new Error(`libnsfb render failed with code ${renderResult}`);
      }
      copyFramebufferToCanvas(module);
      if (tick === 0) {
        status.innerHTML = '<span class="ok">Visible:</span> copied libnsfb RAM framebuffer bytes into Canvas ImageData.';
        document.body.dataset.netsurfCanvasVisible = 'true';
      }
      tick = (tick + 1) & 0xffff;
      requestAnimationFrame(render);
    };
    render();
  }

  boot().catch((error) => {
    status.textContent = `NetSurf canvas probe failed: ${error.message}`;
    appendLog(error.stack || String(error));
    document.body.dataset.netsurfCanvasVisible = 'error';
  });
</script>
HTML

ls -lh \
  "$ARTIFACT_DIR/nsfb.js" \
  "$ARTIFACT_DIR/nsfb.wasm" \
  "$ARTIFACT_DIR/nsfb-canvas-probe.js" \
  "$ARTIFACT_DIR/nsfb-canvas-probe.wasm" \
  "$PUBLIC_DIR/index.html"
