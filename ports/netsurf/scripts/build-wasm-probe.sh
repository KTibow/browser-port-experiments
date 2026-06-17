#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
PORT_DIR="$ROOT/ports/netsurf"
WORK="$PORT_DIR/work"
WORKSPACE="$WORK/workspace"
BIN="$WORK/bin"
LOG="$WORK/build-wasm-probe.log"
HOST_TRIPLET=wasm32-unknown-emscripten
REPO_BASE_URI=${REPO_BASE_URI:-https://github.com/netsurf-browser}
JOBS=${JOBS:-2}

mkdir -p "$BIN" "$WORKSPACE"
exec > >(tee "$LOG") 2>&1

if ! command -v emcc >/dev/null 2>&1; then
  echo "emcc is missing. Run: ports/netsurf/scripts/install-apt-emscripten.sh" >&2
  exit 127
fi

# Debian/Ubuntu's emscripten package ships a frozen global cache.  Copy the
# config and unfreeze it so ports such as zlib can be materialized under work/.
if [[ ! -f "$WORK/emscripten-config" ]]; then
  cp /usr/share/emscripten/.emscripten "$WORK/emscripten-config"
  python3 - "$WORK/emscripten-config" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
s = p.read_text()
s = s.replace('FROZEN_CACHE = True', 'FROZEN_CACHE = False')
p.write_text(s)
PY
fi
export EM_CONFIG="$WORK/emscripten-config"
export EM_CACHE="$WORK/em-cache"
mkdir -p "$EM_CACHE"

make_wrapper() {
  local name=$1 target=$2
  cat > "$BIN/$name" <<EOF_WRAP
#!/bin/sh
case "\${1:-}" in
  --version) echo 'clang version 15.0.7 (emscripten wrapper for NetSurf buildsystem)'; exit 0 ;;
  -dumpspecs) exit 1 ;;
esac
exec $target -sUSE_ZLIB=1 "\$@"
EOF_WRAP
  chmod +x "$BIN/$name"
}
make_wrapper "$HOST_TRIPLET-gcc" /usr/bin/emcc
make_wrapper "$HOST_TRIPLET-cc" /usr/bin/emcc
make_wrapper "$HOST_TRIPLET-g++" /usr/bin/em++
cat > "$BIN/$HOST_TRIPLET-ar" <<'EOF_AR'
#!/bin/sh
exec /usr/bin/emar "$@"
EOF_AR
cat > "$BIN/$HOST_TRIPLET-ranlib" <<'EOF_RANLIB'
#!/bin/sh
exec /usr/bin/emranlib "$@"
EOF_RANLIB
chmod +x "$BIN/$HOST_TRIPLET-ar" "$BIN/$HOST_TRIPLET-ranlib"
export PATH="$BIN:$PATH"

if [[ ! -f "$WORK/env.sh" ]]; then
  curl -fsSL "$REPO_BASE_URI/netsurf/raw/HEAD/docs/env.sh" -o "$WORK/env.sh"
fi

export HOST=$HOST_TRIPLET
export TARGET_WORKSPACE=$WORKSPACE
export USE_CPUS="-j$JOBS"
export REPO_BASE_URI
# NetSurf's env.sh assumes neither nounset nor errexit is active while it
# probes optional commands with failing command substitutions.
set +eu
# shellcheck source=/dev/null
source "$WORK/env.sh"
env_rc=$?
# Keep nounset disabled: NetSurf env functions reference optional unset vars.
set -e
if [[ $env_rc -ne 0 ]]; then
  echo "Failed to source NetSurf env.sh" >&2
  exit "$env_rc"
fi

ns-clone -s
ns-make-tools install

# Build only libraries needed for an offline framebuffer/RAM NetSurf.
# libsvgtiny currently requires libdom's XML binding and an Emscripten expat;
# skip SVG for this first probe.
for repo in buildsystem libwapcaplet libparserutils libhubbub; do
  make -C "$WORKSPACE/$repo" HOST="$HOST_TRIPLET" install
 done
make -C "$WORKSPACE/libdom" HOST="$HOST_TRIPLET" WITH_EXPAT_BINDING=no install
for repo in libcss libnsgif libnsbmp libnsutils libnspsl libnslog libnsfb librosprite; do
  make -C "$WORKSPACE/$repo" HOST="$HOST_TRIPLET" install
 done

# NetSurf includes fetchers/curl.h even when WITH_CURL is disabled; avoid a
# cross libcurl requirement until a BrowserPortWisp-backed fetcher exists.
python3 - "$WORKSPACE/netsurf/content/fetchers/curl.h" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
s = p.read_text()
needle = '#include <curl/curl.h>'
replacement = '#ifdef WITH_CURL\n#include <curl/curl.h>\n#else\ntypedef void CURLM;\n#endif'
if needle in s:
    p.write_text(s.replace(needle, replacement))
PY

cd "$WORKSPACE/netsurf"
make TARGET=framebuffer HOST="$HOST_TRIPLET" clean || true
make TARGET=framebuffer HOST="$HOST_TRIPLET" \
  CC="$HOST_TRIPLET-gcc" CXX="$HOST_TRIPLET-g++" AR="$HOST_TRIPLET-ar" \
  LDFLAGS='-sUSE_ZLIB=1 -sALLOW_MEMORY_GROWTH=1 -sEXIT_RUNTIME=0' \
  NETSURF_FB_FRONTEND=ram \
  NETSURF_USE_CURL=NO NETSURF_USE_JPEG=NO NETSURF_USE_PNG=NO \
  NETSURF_USE_OPENSSL=NO NETSURF_USE_LIBICONV_PLUG=NO NETSURF_USE_UTF8PROC=NO \
  NETSURF_USE_NSSVG=NO NETSURF_USE_ROSPRITE=NO WITH_EXPAT_BINDING=no \
  -j"$JOBS"

mkdir -p "$PORT_DIR/artifacts"
cp -v nsfb nsfb.wasm nsfb.js "$PORT_DIR/artifacts/" 2>/dev/null || true
ls -lh nsfb* "$PORT_DIR/artifacts" || true
