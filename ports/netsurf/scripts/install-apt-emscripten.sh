#!/usr/bin/env bash
set -euo pipefail

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This helper is intentionally the smallest Ubuntu/Debian path; install Emscripten manually otherwise." >&2
  exit 1
fi

sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  ca-certificates git build-essential pkg-config make python3 \
  emscripten flex bison gperf libhtml-parser-perl

emcc -v
emcc -dumpmachine
