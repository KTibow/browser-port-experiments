#!/usr/bin/env bash
set -euo pipefail

# Reproducible NetSurf framebuffer -> wasm32-unknown-emscripten build.
# Validated on Ubuntu 24.04 with Debian Emscripten 3.1.6.

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

if [[ -f /usr/share/emscripten/.emscripten ]]; then
  EM_CONFIG_FILE="$WORK_DIR/emscripten-config.py"
  cp /usr/share/emscripten/.emscripten "$EM_CONFIG_FILE"
  python3 - "$EM_CONFIG_FILE" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
p.write_text(p.read_text().replace('FROZEN_CACHE = True', 'FROZEN_CACHE = False'))
PY
  export EM_CONFIG="$EM_CONFIG_FILE"
fi

if [[ ! -d "$WORKSPACE/netsurf/.git" ]]; then
  git clone --depth 1 "$REPO_BASE_URI/netsurf.git" "$WORKSPACE/netsurf"
fi

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
ns-make-tools install
printf 'WITH_EXPAT_BINDING := no\nWITH_LIBXML_BINDING := no\n' > "$WORKSPACE/libdom/Makefile.config.override"
python3 - "$WORKSPACE/libnsfb" <<'PY'
from pathlib import Path
import sys
root = Path(sys.argv[1])

include = root / 'include/libnsfb.h'
s = include.read_text()
old = '    NSFB_SURFACE_RAM, /**< RAM surface */\n    NSFB_SURFACE_COUNT, /**< The number of surface kinds */'
new = '    NSFB_SURFACE_RAM, /**< RAM surface */\n    NSFB_SURFACE_EMSCRIPTEN, /**< Emscripten canvas callback surface */\n    NSFB_SURFACE_COUNT, /**< The number of surface kinds */'
if old in s and 'NSFB_SURFACE_EMSCRIPTEN' not in s:
    include.write_text(s.replace(old, new))

makefile = root / 'src/surface/Makefile'
s = makefile.read_text()
old = 'SURFACE_HANDLER_yes := surface.c ram.c'
new = 'SURFACE_HANDLER_yes := surface.c ram.c emscripten.c'
if old in s and 'emscripten.c' not in s:
    makefile.write_text(s.replace(old, new))

surface = root / 'src/surface/emscripten.c'
surface.write_text(r'''
/* Emscripten surface for browser-port-experiments NetSurf framebuffer. */

#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#endif

#include "libnsfb.h"
#include "libnsfb_event.h"
#include "libnsfb_plot.h"

#include "nsfb.h"
#include "surface.h"
#include "plot.h"

#define EVENT_QUEUE_LENGTH 128

static nsfb_event_t event_queue[EVENT_QUEUE_LENGTH];
static unsigned int event_read = 0;
static unsigned int event_write = 0;

static bool queue_push(nsfb_event_t event)
{
    unsigned int next = (event_write + 1) % EVENT_QUEUE_LENGTH;
    if (next == event_read) {
        return false;
    }
    event_queue[event_write] = event;
    event_write = next;
    return true;
}

static bool queue_pop(nsfb_event_t *event)
{
    if (event_read == event_write) {
        return false;
    }
    *event = event_queue[event_read];
    event_read = (event_read + 1) % EVENT_QUEUE_LENGTH;
    return true;
}

#ifdef __EMSCRIPTEN__
EM_JS(void, netsurf_emscripten_surface_update_js, (int ptr, int stride, int width, int height, int x, int y, int w, int h), {
    if (Module.netsurfOnFramebufferUpdate) {
        Module.netsurfOnFramebufferUpdate(ptr, stride, width, height, x, y, w, h);
    }
});
#endif

static int emscripten_defaults(nsfb_t *nsfb)
{
    nsfb->width = 640;
    nsfb->height = 480;
    nsfb->format = NSFB_FMT_XRGB8888;
    select_plotters(nsfb);
    return 0;
}

static int emscripten_initialise(nsfb_t *nsfb)
{
    size_t size = (nsfb->width * nsfb->height * nsfb->bpp) / 8;
    uint8_t *fbptr = realloc(nsfb->ptr, size);
    if (fbptr == NULL) {
        return -1;
    }

    nsfb->ptr = fbptr;
    nsfb->linelen = (nsfb->width * nsfb->bpp) / 8;
    return 0;
}

static int emscripten_finalise(nsfb_t *nsfb)
{
    free(nsfb->ptr);
    nsfb->ptr = NULL;
    return 0;
}

static int emscripten_set_geometry(nsfb_t *nsfb, int width, int height, enum nsfb_format_e format)
{
    int startsize = (nsfb->width * nsfb->height * nsfb->bpp) / 8;
    int prev_width = nsfb->width;
    int prev_height = nsfb->height;
    enum nsfb_format_e prev_format = nsfb->format;

    if (width > 0) nsfb->width = width;
    if (height > 0) nsfb->height = height;
    if (format != NSFB_FMT_ANY) nsfb->format = format;

    select_plotters(nsfb);

    if (nsfb->ptr != NULL) {
        int endsize = (nsfb->width * nsfb->height * nsfb->bpp) / 8;
        if (startsize != endsize) {
            uint8_t *fbptr = realloc(nsfb->ptr, endsize);
            if (fbptr == NULL) {
                nsfb->width = prev_width;
                nsfb->height = prev_height;
                nsfb->format = prev_format;
                select_plotters(nsfb);
                return -1;
            }
            nsfb->ptr = fbptr;
        }
    }

    nsfb->linelen = (nsfb->width * nsfb->bpp) / 8;
    return 0;
}

static bool emscripten_input(nsfb_t *nsfb, nsfb_event_t *event, int timeout)
{
    (void)nsfb;
    (void)timeout;
    return queue_pop(event);
}

static int emscripten_update(nsfb_t *nsfb, nsfb_bbox_t *box)
{
    int x0 = box->x0 < 0 ? 0 : box->x0;
    int y0 = box->y0 < 0 ? 0 : box->y0;
    int x1 = box->x1 > nsfb->width ? nsfb->width : box->x1;
    int y1 = box->y1 > nsfb->height ? nsfb->height : box->y1;

    if (x1 <= x0 || y1 <= y0 || nsfb->ptr == NULL) {
        return 0;
    }

#ifdef __EMSCRIPTEN__
    netsurf_emscripten_surface_update_js((int)(uintptr_t)nsfb->ptr, nsfb->linelen, nsfb->width, nsfb->height, x0, y0, x1 - x0, y1 - y0);
#endif
    return 0;
}

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
int netsurf_framebuffer_push_key(int down, int keycode)
{
    nsfb_event_t event;
    event.type = down ? NSFB_EVENT_KEY_DOWN : NSFB_EVENT_KEY_UP;
    event.value.keycode = (enum nsfb_key_code_e)keycode;
    return queue_push(event) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE
int netsurf_framebuffer_push_mouse(int down, int button)
{
    int keycode = NSFB_KEY_MOUSE_1;
    nsfb_event_t event;
    if (button == 1) keycode = NSFB_KEY_MOUSE_2;
    if (button == 2) keycode = NSFB_KEY_MOUSE_3;
    event.type = down ? NSFB_EVENT_KEY_DOWN : NSFB_EVENT_KEY_UP;
    event.value.keycode = (enum nsfb_key_code_e)keycode;
    return queue_push(event) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE
int netsurf_framebuffer_push_motion(int x, int y)
{
    nsfb_event_t event;
    event.type = NSFB_EVENT_MOVE_ABSOLUTE;
    event.value.vector.x = x;
    event.value.vector.y = y;
    event.value.vector.z = 0;
    return queue_push(event) ? 1 : 0;
}
#endif

const nsfb_surface_rtns_t emscripten_rtns = {
    .defaults = emscripten_defaults,
    .initialise = emscripten_initialise,
    .finalise = emscripten_finalise,
    .input = emscripten_input,
    .geometry = emscripten_set_geometry,
    .update = emscripten_update,
};

NSFB_SURFACE_DEF(emscripten, NSFB_SURFACE_EMSCRIPTEN, &emscripten_rtns)
''')
PY

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
override NETSURF_USE_LIBICONV_PLUG := YES
override NETSURF_USE_UTF8PROC := NO
override NETSURF_USE_BMP := YES
override NETSURF_USE_GIF := YES
override NETSURF_USE_NSPSL := YES
override NETSURF_USE_NSLOG := YES
override NETSURF_FB_FONTLIB := internal
override NETSURF_FB_FRONTEND := emscripten
LDFLAGS += -sUSE_ZLIB -sMODULARIZE=1 -sEXPORT_NAME=createNetSurfFrameBuffer -sENVIRONMENT=web,worker -sALLOW_MEMORY_GROWTH=1 -sEXIT_RUNTIME=0 -sEXPORTED_FUNCTIONS=["_netsurf_framebuffer_main","_netsurf_framebuffer_ptr","_netsurf_framebuffer_width","_netsurf_framebuffer_height","_netsurf_framebuffer_stride","_netsurf_framebuffer_push_key","_netsurf_framebuffer_push_mouse","_netsurf_framebuffer_push_motion"] -sEXPORTED_RUNTIME_METHODS=["ccall","cwrap"]
EOF

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

python3 - "$WORKSPACE/netsurf/frontends/framebuffer/framebuffer.c" "$WORKSPACE/netsurf/frontends/framebuffer/gui.c" <<'PY'
from pathlib import Path
import sys
framebuffer = Path(sys.argv[1])
gui = Path(sys.argv[2])

s = framebuffer.read_text()
if '#include <emscripten/emscripten.h>' not in s:
    s = s.replace('#include <libnsfb_cursor.h>\n', '#include <libnsfb_cursor.h>\n\n#ifdef __EMSCRIPTEN__\n#include <emscripten/emscripten.h>\n#endif\n')
marker = '/* netsurf framebuffer library handle */\nstatic nsfb_t *nsfb;\n'
exports = '''
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
int netsurf_framebuffer_ptr(void)
{
    uint8_t *buffer = NULL;
    int stride = 0;

    if (nsfb == NULL) return 0;
    if (nsfb_get_buffer(nsfb, &buffer, &stride) != 0) return 0;
    return (int)(uintptr_t)buffer;
}

EMSCRIPTEN_KEEPALIVE
int netsurf_framebuffer_width(void)
{
    int width = 0;
    if (nsfb != NULL) nsfb_get_geometry(nsfb, &width, NULL, NULL);
    return width;
}

EMSCRIPTEN_KEEPALIVE
int netsurf_framebuffer_height(void)
{
    int height = 0;
    if (nsfb != NULL) nsfb_get_geometry(nsfb, NULL, &height, NULL);
    return height;
}

EMSCRIPTEN_KEEPALIVE
int netsurf_framebuffer_stride(void)
{
    uint8_t *buffer = NULL;
    int stride = 0;

    if (nsfb == NULL) return 0;
    if (nsfb_get_buffer(nsfb, &buffer, &stride) != 0) return 0;
    return stride;
}
#endif

'''
if 'netsurf_framebuffer_ptr' not in s:
    s = s.replace(marker, marker + exports)
framebuffer.write_text(s)

s = gui.read_text()
if '#include <emscripten/emscripten.h>' not in s:
    s = s.replace('#include <nsutils/time.h>\n', '#include <nsutils/time.h>\n\n#ifdef __EMSCRIPTEN__\n#include <emscripten/emscripten.h>\n#endif\n')
old = '''static void framebuffer_run(void)
{
\tnsfb_event_t event;
\tint timeout; /* timeout in miliseconds */

\twhile (fb_complete != true) {
\t\t/* run the scheduler and discover how long to wait for
\t\t * the next event.
\t\t */
\t\ttimeout = schedule_run();

\t\t/* if redraws are pending do not wait for event,
\t\t * return immediately
\t\t */
\t\tif (fbtk_get_redraw_pending(fbtk))
\t\t\ttimeout = 0;

\t\tif (fbtk_event(fbtk, &event, timeout)) {
\t\t\tif ((event.type == NSFB_EVENT_CONTROL) &&
\t\t\t    (event.value.controlcode ==  NSFB_CONTROL_QUIT))
\t\t\t\tfb_complete = true;
\t\t}

\t\tfbtk_redraw(fbtk);
\t}
}
'''
new = '''static void framebuffer_run_iteration(void)
{
\tnsfb_event_t event;
\tint timeout; /* timeout in miliseconds */

\ttimeout = schedule_run();
\tif (fbtk_get_redraw_pending(fbtk))
\t\ttimeout = 0;

\tif (fbtk_event(fbtk, &event, timeout)) {
\t\tif ((event.type == NSFB_EVENT_CONTROL) &&
\t\t    (event.value.controlcode ==  NSFB_CONTROL_QUIT))
\t\t\tfb_complete = true;
\t}

\tfbtk_redraw(fbtk);
}

static void framebuffer_run(void)
{
#ifdef __EMSCRIPTEN__
\temscripten_set_main_loop(framebuffer_run_iteration, 0, true);
#else
\twhile (fb_complete != true) {
\t\tframebuffer_run_iteration();
\t}
#endif
}
'''
if old in s:
    s = s.replace(old, new)
wrapper = '''
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
int netsurf_framebuffer_main(void)
{
\tchar arg0[] = "nsfb";
\tchar arg1[] = "-f";
\tchar arg2[] = "emscripten";
\tchar arg3[] = "-w";
\tchar arg4[] = "640";
\tchar arg5[] = "-h";
\tchar arg6[] = "480";
\tchar arg7[] = "about:blank";
\tchar *argv[] = { arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7 };

\treturn main(8, argv);
}
#endif

'''
if 'netsurf_framebuffer_main' not in s:
    s = s.replace('\nvoid gui_resize(fbtk_widget_t *root, int width, int height)\n', '\n' + wrapper + 'void gui_resize(fbtk_widget_t *root, int width, int height)\n')
gui.write_text(s)
PY

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
  "-j$JOBS"

cp "$WORKSPACE/netsurf/nsfb" "$ARTIFACT_DIR/nsfb.js"
cp "$WORKSPACE/netsurf/nsfb.wasm" "$ARTIFACT_DIR/nsfb.wasm"
cp "$ARTIFACT_DIR/nsfb.js" "$PUBLIC_DIR/nsfb.js"
cp "$ARTIFACT_DIR/nsfb.wasm" "$PUBLIC_DIR/nsfb.wasm"
if [[ "$ROOT_DIR/public/browsers/netsurf/index.html" != "$PUBLIC_DIR/index.html" ]]; then
  cp "$ROOT_DIR/public/browsers/netsurf/index.html" "$PUBLIC_DIR/index.html"
fi
cat > "$PUBLIC_DIR/build-manifest.txt" <<'EOF'
Built by ports/netsurf/scripts/build-framebuffer-wasm.sh
Frontend: full NetSurf framebuffer with patched libnsfb Emscripten dirty-rect surface
JS entry: createNetSurfFrameBuffer; page calls netsurf_framebuffer_main and paints nsfb_update dirty rectangles
Input: basic canvas mouse, wheel, and keyboard events queue into libnsfb/fbtk
Networking: CURL disabled; offline about:, data:, file/resource fetchers only; future socket fetcher should use BrowserPortWisp from the app with no endpoint hard-coded in C/WASM
EOF
cat > "$PUBLIC_DIR/probe.html" <<'EOF'
<!doctype html>
<meta charset="utf-8" />
<meta http-equiv="refresh" content="0; url=./" />
<title>NetSurf WASM probe moved</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; max-width: 60rem; line-height: 1.5; }
  code { background: #f4f4f5; padding: .15rem .3rem; border-radius: .25rem; }
</style>
<h1>NetSurf WASM probe moved</h1>
<p>The standalone libnsfb canvas probe has been superseded by the full NetSurf framebuffer frontend.</p>
<p><a href="./">Open the NetSurf framebuffer canvas page</a>.</p>
<p>Networking is still disabled in the artifact. The next networking lane should use <code>BrowserPortWisp</code> from the host app and must not hard-code a Wisp endpoint into NetSurf C/WASM code.</p>
EOF

ls -lh \
  "$ARTIFACT_DIR/nsfb.js" \
  "$ARTIFACT_DIR/nsfb.wasm" \
  "$PUBLIC_DIR/index.html"
