# Self-hosted image mirror (resilience + test assets)

These are the *small, critical* OS images / assets, mirrored into the repo so the
site does not depend on copy.sh availability for its flagship demo, its deploy
gate (`@smoke`), its networking proof (`@network`), or its browser-rendering
proof (`@browse`).

| file | bytes | used by |
| --- | --- | --- |
| `kolibri.img` | 1474560 | KolibriOS flagship + `@smoke` gate |
| `buildroot-bzimage.bin` | 5166352 | `@network` Wisp fetch proof + `@browse` host kernel |
| `links-initrd.cpio.gz` | ~3.7 MB | `@browse` (a real text browser rendering a page over Wisp) |

`kolibri.img` / `buildroot-bzimage.bin` are byte-identical copies of copy.sh's
`https://i.copy.sh/kolibri.img` and `https://i.copy.sh/buildroot-bzimage.bin`
(verified: valid KOLIBRI FAT12 boot sector / valid Linux 5.6.15 bzImage "HdrS"
header). The build copies this folder verbatim into `dist/mirror/`; GitHub Pages
serves it same-origin with range + CORS support.

## `links-initrd.cpio.gz` (the @browse proof)

A tiny external initramfs holding a static 32-bit (i386/musl) **Twibright Links**
text browser + its shared libs (musl, openssl, libevent, zlib, bzip2, zstd) + a
CA bundle. The `@browse` test boots `buildroot-bzimage.bin` (which has a built-in
busybox initramfs) and supplies this cpio as an **external initrd**; the kernel
extracts it *on top of* the built-in rootfs, so `/usr/bin/links` and friends
appear in the running guest. Over the serial console the test then runs
`links -dump http(s)://example.com` — proving a real browser engine fetches AND
*renders* a live page over Wisp (HTTP and HTTPS/TLS). Regenerate / refresh with
`scripts/build-links-initrd.sh` (pulls prebuilt binaries from the Alpine x86
package repo — no toolchain needed).

`browsers.json` images carry an optional `mirror` field pointing here; the runner
prefers it unless a `?cdn=` override is supplied (so `?cdn=https://i.copy.sh/`
forces streaming from copy.sh again). To refresh: re-download with **no Referer**
(`curl https://i.copy.sh/<file>`) and confirm the size matches.
