#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
JS="$ROOT_DIR/ports/netsurf/artifacts/nsfb.js"
WASM="$ROOT_DIR/ports/netsurf/artifacts/nsfb.wasm"
PUBLIC_JS="$ROOT_DIR/public/browsers/netsurf/nsfb.js"
PUBLIC_WASM="$ROOT_DIR/public/browsers/netsurf/nsfb.wasm"

for file in "$JS" "$WASM" "$PUBLIC_JS" "$PUBLIC_WASM" "$ROOT_DIR/public/browsers/netsurf/index.html"; do
  [[ -s "$file" ]] || { echo "missing or empty: $file" >&2; exit 1; }
done

node --check "$JS"
node - <<'NODE' "$WASM"
const fs = require('node:fs');
const bytes = fs.readFileSync(process.argv[2]);
if (bytes.toString('ascii', 0, 4) !== '\0asm') {
  throw new Error('nsfb.wasm does not start with the WebAssembly magic');
}
console.log(`verified wasm artifact (${bytes.length} bytes)`);
NODE
