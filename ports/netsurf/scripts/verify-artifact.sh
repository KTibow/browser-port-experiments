#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
JS="$ROOT_DIR/ports/netsurf/artifacts/nsfb.js"
WASM="$ROOT_DIR/ports/netsurf/artifacts/nsfb.wasm"
CANVAS_JS="$ROOT_DIR/ports/netsurf/artifacts/nsfb-canvas-probe.js"
CANVAS_WASM="$ROOT_DIR/ports/netsurf/artifacts/nsfb-canvas-probe.wasm"
PUBLIC_JS="$ROOT_DIR/public/browsers/netsurf/nsfb.js"
PUBLIC_WASM="$ROOT_DIR/public/browsers/netsurf/nsfb.wasm"
PUBLIC_CANVAS_JS="$ROOT_DIR/public/browsers/netsurf/nsfb-canvas-probe.js"
PUBLIC_CANVAS_WASM="$ROOT_DIR/public/browsers/netsurf/nsfb-canvas-probe.wasm"

for file in "$JS" "$WASM" "$CANVAS_JS" "$CANVAS_WASM" "$PUBLIC_JS" "$PUBLIC_WASM" "$PUBLIC_CANVAS_JS" "$PUBLIC_CANVAS_WASM" "$ROOT_DIR/public/browsers/netsurf/index.html"; do
  [[ -s "$file" ]] || { echo "missing or empty: $file" >&2; exit 1; }
done

node --check "$JS"
node --check "$CANVAS_JS"
node - <<'NODE' "$WASM" "$CANVAS_WASM"
const fs = require('node:fs');
for (const path of process.argv.slice(2)) {
  const bytes = fs.readFileSync(path);
  if (bytes.toString('ascii', 0, 4) !== '\0asm') {
    throw new Error(`${path} does not start with the WebAssembly magic`);
  }
  console.log(`verified wasm artifact ${path} (${bytes.length} bytes)`);
}
NODE
