#!/usr/bin/env bash
set -euo pipefail

# Smallest path found on Ubuntu 24.04 GitHub runners: distro Emscripten.
# It is older than upstream emsdk but avoids a separate SDK checkout and is enough
# to compile the current RAM-framebuffer NetSurf probe.
sudo apt-get update -y
sudo apt-get install -y --no-install-recommends \
  emscripten \
  git \
  make \
  pkg-config \
  python3 \
  flex \
  bison \
  gperf \
  perl

emcc -v
