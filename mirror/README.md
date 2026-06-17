# Self-hosted image mirror (resilience)

These are the *small, critical* OS images, mirrored into the repo so the site
does not depend on copy.sh availability for its flagship demo, its deploy gate
(`@smoke`), or its end-to-end networking proof (`@network`).

| file | bytes | sha256 (first 12) | used by |
| --- | --- | --- | --- |
| `kolibri.img` | 1474560 | f3ec74d5b70e | KolibriOS flagship + `@smoke` gate |
| `buildroot-bzimage.bin` | 5166352 | 7befbaea31e2 | `@network` Wisp fetch proof |

They are byte-identical copies of copy.sh's `https://i.copy.sh/kolibri.img` and
`https://i.copy.sh/buildroot-bzimage.bin` (verified: valid KOLIBRI FAT12 boot
sector / valid Linux 5.6.15 bzImage "HdrS" header). The build copies this folder
verbatim into `dist/mirror/`; GitHub Pages serves it same-origin with range +
CORS support.

`browsers.json` images carry an optional `mirror` field pointing here; the runner
prefers it unless a `?cdn=` override is supplied (so `?cdn=https://i.copy.sh/`
forces streaming from copy.sh again). To refresh: re-download with **no Referer**
(`curl https://i.copy.sh/<file>`) and confirm the size matches.
