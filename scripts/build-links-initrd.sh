#!/usr/bin/env bash
# Build mirror/links-initrd.cpio.gz — a tiny external initramfs that overlays a
# static text-mode web browser (Twibright Links) + its musl libs + a CA bundle
# onto the Buildroot guest used by the @network / @browse tests.
#
# Why: the @browse test boots the mirrored Buildroot bzImage (which has a
# built-in busybox initramfs) and supplies this cpio as an *external* initrd.
# The kernel extracts the external initrd ON TOP of the built-in one, so
# /usr/bin/links + /lib/ld-musl-i386.so.1 + the shared libs + /etc/ssl certs
# appear in the running rootfs. Over the serial console we then run
# `links -dump http(s)://example.com` to prove a real browser engine renders a
# live page over Wisp.
#
# We grab prebuilt 32-bit (i386/musl) binaries from the Alpine x86 package repo
# rather than cross-compiling — no toolchain, fully reproducible, and links is
# already built with OpenSSL so HTTPS works.
#
# Usage:  scripts/build-links-initrd.sh [alpine_version]   (default v3.20)
set -euo pipefail

ALPINE_VER="${1:-v3.20}"
BASE="https://dl-cdn.alpinelinux.org/alpine/${ALPINE_VER}/main/x86"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/mirror/links-initrd.cpio.gz"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo ">> Alpine x86 (32-bit) repo: $BASE"
curl -fsS "$BASE/APKINDEX.tar.gz" -o "$WORK/idx.tgz"
tar xzf "$WORK/idx.tgz" -C "$WORK"

# Resolve the package that *provides* each soname links needs, plus links/musl.
ver() { awk -v p="$1" 'BEGIN{RS="\n\n"} $0 ~ ("\nP:" p "\n"){ if(match($0,/\nV:[^\n]*/)) print substr($0,RSTART+3,RLENGTH-3); exit }' "$WORK/APKINDEX"; }
provider() { awk -v s="so:$1=" 'BEGIN{RS="\n\n"} index($0,s){ if(match($0,/\nP:[^\n]*/)) P=substr($0,RSTART+3,RLENGTH-3); if(match($0,/\nV:[^\n]*/)) V=substr($0,RSTART+3,RLENGTH-3); print P"-"V; exit }' "$WORK/APKINDEX"; }

PKGS=(
  "links-$(ver links)"
  "musl-$(ver musl)"
  "ca-certificates-bundle-$(ver ca-certificates-bundle)"
  "$(provider libbz2.so.1)"
  "$(provider libcrypto.so.3)"
  "$(provider libssl.so.3)"
  "$(provider libevent-2.1.so.7)"
  "$(provider libz.so.1)"
  "$(provider libzstd.so.1)"
)

mkdir -p "$WORK/extract"
for p in "${PKGS[@]}"; do
  echo ">> fetch $p"
  curl -fsS "$BASE/$p.apk" -o "$WORK/$p.apk"
  tar -xzf "$WORK/$p.apk" -C "$WORK/extract" 2>/dev/null || true
done

# Assemble a minimal tree: the browser, the musl loader + needed shared libs,
# the musl search path, and the CA bundle (for HTTPS).
T="$WORK/initrd"
mkdir -p "$T/usr/bin" "$T/lib" "$T/usr/lib" "$T/etc" "$T/etc/ssl/certs"
E="$WORK/extract"
cp -a "$E/usr/bin/links"                                   "$T/usr/bin/"
cp -a "$E"/lib/ld-musl-i386.so.1 "$E"/lib/libc.musl-x86.so.1 "$T/lib/"
cp -a "$E"/lib/libcrypto.so.3 "$E"/lib/libssl.so.3          "$T/lib/"
cp -a "$E"/lib/libz.so.1*                                   "$T/lib/"
cp -a "$E"/usr/lib/libbz2.so.1*  "$E"/usr/lib/libevent-2.1.so.7* "$E"/usr/lib/libzstd.so.1* "$T/usr/lib/"
ln -sf ../../lib/libcrypto.so.3 "$T/usr/lib/libcrypto.so.3"
ln -sf ../../lib/libssl.so.3    "$T/usr/lib/libssl.so.3"
printf '/lib:/usr/lib\n' > "$T/etc/ld-musl-i386.path"
cp -a "$E/etc/ssl/certs/ca-certificates.crt" "$T/etc/ssl/certs/"
ln -sf certs/ca-certificates.crt "$T/etc/ssl/cert.pem"

( cd "$T" && find . | cpio -o -H newc 2>/dev/null | gzip -9 ) > "$OUT"
echo ">> wrote $OUT ($(stat -c%s "$OUT") bytes)"
echo ">> verify: zcat | cpio -t"
zcat "$OUT" | cpio -t 2>/dev/null | sed 's/^/   /'
