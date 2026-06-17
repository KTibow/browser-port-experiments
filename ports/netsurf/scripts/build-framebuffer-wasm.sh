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
override NETSURF_FB_FRONTEND := ram
LDFLAGS += -sUSE_ZLIB -sMODULARIZE=1 -sEXPORT_NAME=createNetSurfFrameBuffer -sENVIRONMENT=web,worker -sALLOW_MEMORY_GROWTH=1 -sEXIT_RUNTIME=0 -sEXPORTED_FUNCTIONS=["_netsurf_framebuffer_main","_netsurf_framebuffer_ptr","_netsurf_framebuffer_width","_netsurf_framebuffer_height","_netsurf_framebuffer_stride","_netsurf_framebuffer_input_key","_netsurf_framebuffer_input_mouse_move","_netsurf_framebuffer_input_mouse_button","_netsurf_framebuffer_dirty_count","_netsurf_framebuffer_dirty_x0","_netsurf_framebuffer_dirty_y0","_netsurf_framebuffer_dirty_x1","_netsurf_framebuffer_dirty_y1"] -sEXPORTED_RUNTIME_METHODS=["ccall"]
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

python3 - "$WORKSPACE/libnsfb/src/surface/ram.c" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
s = p.read_text()
if '#include <emscripten/emscripten.h>' not in s:
    s = s.replace('#include <stdlib.h>\n', '#include <stdlib.h>\n\n#ifdef __EMSCRIPTEN__\n#include <emscripten/emscripten.h>\n#endif\n')
old = '''static bool ram_input(nsfb_t *nsfb, nsfb_event_t *event, int timeout)
{
    UNUSED(nsfb);
    UNUSED(event);
    UNUSED(timeout);
    return false;
}
'''
new = '''#ifdef __EMSCRIPTEN__
#define RAM_EVENT_QUEUE_LEN 64
static nsfb_event_t ram_event_queue[RAM_EVENT_QUEUE_LEN];
static int ram_event_head;
static int ram_event_tail;
static int ram_event_dropped;
static int ram_dirty_count;
static nsfb_bbox_t ram_last_dirty;

static bool ram_event_queue_empty(void)
{
    return ram_event_head == ram_event_tail;
}

static int ram_push_event(nsfb_event_t *event)
{
    int next_tail = (ram_event_tail + 1) % RAM_EVENT_QUEUE_LEN;

    if (next_tail == ram_event_head) {
        ram_event_dropped++;
        return 0;
    }

    ram_event_queue[ram_event_tail] = *event;
    ram_event_tail = next_tail;
    return 1;
}

EMSCRIPTEN_KEEPALIVE
int netsurf_framebuffer_input_key(int keycode, int down)
{
    nsfb_event_t event;

    event.type = down ? NSFB_EVENT_KEY_DOWN : NSFB_EVENT_KEY_UP;
    event.value.keycode = (enum nsfb_key_code_e)keycode;
    return ram_push_event(&event);
}

EMSCRIPTEN_KEEPALIVE
int netsurf_framebuffer_input_mouse_move(int x, int y)
{
    nsfb_event_t event;

    event.type = NSFB_EVENT_MOVE_ABSOLUTE;
    event.value.vector.x = x;
    event.value.vector.y = y;
    event.value.vector.z = 0;
    return ram_push_event(&event);
}

EMSCRIPTEN_KEEPALIVE
int netsurf_framebuffer_input_mouse_button(int button, int down)
{
    nsfb_event_t event;

    if (button < 1 || button > 5) {
        return 0;
    }

    event.type = down ? NSFB_EVENT_KEY_DOWN : NSFB_EVENT_KEY_UP;
    event.value.keycode = (enum nsfb_key_code_e)(NSFB_KEY_MOUSE_1 + button - 1);
    return ram_push_event(&event);
}

EMSCRIPTEN_KEEPALIVE
int netsurf_framebuffer_dirty_count(void)
{
    return ram_dirty_count;
}

EMSCRIPTEN_KEEPALIVE int netsurf_framebuffer_dirty_x0(void) { return ram_last_dirty.x0; }
EMSCRIPTEN_KEEPALIVE int netsurf_framebuffer_dirty_y0(void) { return ram_last_dirty.y0; }
EMSCRIPTEN_KEEPALIVE int netsurf_framebuffer_dirty_x1(void) { return ram_last_dirty.x1; }
EMSCRIPTEN_KEEPALIVE int netsurf_framebuffer_dirty_y1(void) { return ram_last_dirty.y1; }

static bool ram_input(nsfb_t *nsfb, nsfb_event_t *event, int timeout)
{
    UNUSED(nsfb);
    UNUSED(timeout);

    if (ram_event_queue_empty()) {
        return false;
    }

    *event = ram_event_queue[ram_event_head];
    ram_event_head = (ram_event_head + 1) % RAM_EVENT_QUEUE_LEN;
    return true;
}

static int ram_update(nsfb_t *nsfb, nsfb_bbox_t *box)
{
    if (box == NULL) {
        ram_last_dirty.x0 = 0;
        ram_last_dirty.y0 = 0;
        ram_last_dirty.x1 = nsfb->width;
        ram_last_dirty.y1 = nsfb->height;
    } else {
        ram_last_dirty = *box;
    }
    ram_dirty_count++;

    EM_ASM({
        if (typeof Module !== 'undefined' && typeof Module.onNetSurfFramebufferDirtyRect === 'function') {
            Module.onNetSurfFramebufferDirtyRect($0, $1, $2, $3, $4);
        }
    }, ram_last_dirty.x0, ram_last_dirty.y0, ram_last_dirty.x1, ram_last_dirty.y1, ram_dirty_count);

    return 0;
}
#else
static bool ram_input(nsfb_t *nsfb, nsfb_event_t *event, int timeout)
{
    UNUSED(nsfb);
    UNUSED(event);
    UNUSED(timeout);
    return false;
}

static int ram_update(nsfb_t *nsfb, nsfb_bbox_t *box)
{
    UNUSED(nsfb);
    UNUSED(box);
    return 0;
}
#endif
'''
if old in s:
    s = s.replace(old, new)
s = s.replace('''    .input = ram_input,
    .geometry = ram_set_geometry,
};
''', '''    .input = ram_input,
    .geometry = ram_set_geometry,
    .update = ram_update,
};
''')
p.write_text(s)
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
\tchar arg2[] = "ram";
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
cp "$ROOT_DIR/public/browsers/netsurf/index.html" "$PUBLIC_DIR/index.html"
cat > "$PUBLIC_DIR/build-manifest.txt" <<'EOF'
Built by ports/netsurf/scripts/build-framebuffer-wasm.sh
Frontend: full NetSurf framebuffer with libnsfb RAM surface
JS entry: createNetSurfFrameBuffer; page calls netsurf_framebuffer_main and copies live nsfb_t pixels
Canvas presenter: public page polls full-frame pixels and exposes window.netsurfFramebufferState/data-* metadata
Input: public page captures canvas pointer/keyboard/wheel events; rebuilt artifacts export a libnsfb RAM-surface event queue consumed by fbtk_event
Dirty rects: rebuilt artifacts add a libnsfb RAM-surface update callback while the public metadata contract remains presenter=full-frame-poll
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
