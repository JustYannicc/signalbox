#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
WORK="${1:?usage: build-sed.sh <fresh work root> <artifact output>}"
OUTPUT="${2:?usage: build-sed.sh <fresh work root> <artifact output>}"
[[ ! -e "$WORK" ]] || { echo "GNU sed build root must be fresh: $WORK" >&2; exit 1; }
mkdir -p "$WORK/inputs" "$(dirname -- "$OUTPUT")"
WORK="$(cd -- "$WORK" && pwd -P)"
OUTPUT="$(cd -- "$(dirname -- "$OUTPUT")" && pwd -P)/$(basename -- "$OUTPUT")"
IMAGE="node@sha256:14078204b6bb268c107ceff6d3c43f45a888105e5c2b18b14c32b3409d93a1b0"

fetch() {
  local url="$1" digest="$2" name="$3"
  if [[ -n "${SOURCE_CACHE_DIR:-}" && -f "$SOURCE_CACHE_DIR/$name" ]]; then
    cp "$SOURCE_CACHE_DIR/$name" "$WORK/inputs/$name"
  else
    curl -fLsS "$url" -o "$WORK/inputs/$name"
  fi
  echo "$digest  $WORK/inputs/$name" | shasum -a 256 -c -
}
fetch https://ftp.gnu.org/gnu/sed/sed-4.9.tar.xz \
  6e226b732e1cd739464ad6862bd1a1aba42d7982922da7a53519631d24975181 sed-4.9.tar.xz
fetch https://codeload.github.com/AshishKumar4/Nimbus/tar.gz/e9f019ab4e40cb6037aff7e1a0eaf20842578ed3 \
  f7024781c3dc2be1325efa1279aa9682cd84a2cd48f7782eb87ccd90ff0f1c12 nimbus.tar.gz
fetch https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-25/wasi-sdk-25.0-arm64-linux.tar.gz \
  47fccad8b2498f2239e05e1115c3ffc652bf37e7de2f88fb64b2d663c976ce2d wasi-sdk-25.tar.gz

mkdir "$WORK/output"
docker run --rm -i --network none --platform linux/arm64 --cpus 2 --memory 4g \
  --tmpfs /build:rw,exec,size=2g \
  --mount "type=bind,source=$WORK/inputs,target=/inputs,readonly" \
  --mount "type=bind,source=$HERE,target=/recipe,readonly" \
  --mount "type=bind,source=$WORK/output,target=/output" \
  "$IMAGE" bash -s > "$WORK/build.log" 2>&1 <<'BUILD'
set -euo pipefail
export SOURCE_DATE_EPOCH=1727308800 TZ=UTC LC_ALL=C
cd /build
tar -xJf /inputs/sed-4.9.tar.xz
tar -xzf /inputs/nimbus.tar.gz
tar -xzf /inputs/wasi-sdk-25.tar.gz
patch -d /build/sed-4.9 -p1 < /recipe/patches/0001-sed-wasi-fd-limit.patch
SDK=/build/wasi-sdk-25.0-arm64-linux
NIMBUS=/build/Nimbus-e9f019ab4e40cb6037aff7e1a0eaf20842578ed3/packages/worker/wasm
SHIM=$NIMBUS/bash/coreutils
LIBC=$NIMBUS/nimbus-libc
mkdir /build/configured /build/shims
cd /build/configured
export CC="$SDK/bin/wasm32-wasi-clang" AR="$SDK/bin/llvm-ar" RANLIB="$SDK/bin/llvm-ranlib"
export CFLAGS='-O2 -std=gnu17 -DF_DUPFD=0 -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_MMAN'
export LDFLAGS='-Wl,--strip-debug -lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-mman'
# Nimbus supplies fchown. Preview 1 has no sockets; its byte order is little endian.
export ac_cv_func_fchown=yes ac_cv_c_bigendian=no
export ac_cv_header_sys_socket_h=no ac_cv_header_netinet_in_h=no ac_cv_type_socklen_t=yes
/build/sed-4.9/configure --build=aarch64-unknown-linux-gnu --host=wasm32-wasi \
  --disable-nls --disable-gcc-warnings --disable-acl --without-selinux > /output/configure.log 2>&1
INCLUDES="-isystem $SHIM/overlay -isystem $LIBC/posix"
for unit in "$SHIM/wasi-shim.c" "$LIBC/nimbus-accounts.c" "$LIBC/nimbus-restart.c"; do
  "$CC" $CFLAGS -D_GNU_SOURCE $INCLUDES -c "$unit" -o "/build/shims/$(basename "$unit" .c).o"
done
LINK="$LDFLAGS /build/shims/wasi-shim.o /build/shims/nimbus-accounts.o /build/shims/nimbus-restart.o"
for symbol in stat lstat fstat fstatat chmod fchmod __main_argc_argv read readv write writev; do
  LINK="$LINK -Wl,--wrap=$symbol"
done
# config.h must define _GNU_SOURCE before the compatibility header includes libc headers.
make -j2 sed/sed CFLAGS="$CFLAGS $INCLUDES -include /build/configured/config.h -include $SHIM/overlay/nimbus-wasi-compat.h" \
  LDFLAGS="$LINK" > /output/compile.log 2>&1
cp sed/sed /output/sed.wasm
cp /build/sed-4.9/COPYING /output/GNU-sed-COPYING
cp /build/Nimbus-e9f019ab4e40cb6037aff7e1a0eaf20842578ed3/LICENSE /output/Nimbus-LICENSE
BUILD
cp "$WORK/output/sed.wasm" "$OUTPUT"
node --input-type=module - "$WORK" "$OUTPUT" "$HERE" "$IMAGE" <<'MANIFEST'
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
const [work, output, here, image] = process.argv.slice(2);
const hash = path => createHash("sha256").update(readFileSync(path)).digest("hex");
const bytes = readFileSync(output);
const module = new WebAssembly.Module(bytes);
const manifest = {
  program: "GNU sed 4.9", version: "4.9+wasi.1", license: "GPL-3.0-or-later", image,
  recipeSha256: hash(`${here}/build-sed.sh`),
  source: {url:"https://ftp.gnu.org/gnu/sed/sed-4.9.tar.xz",sha256:hash(`${work}/inputs/sed-4.9.tar.xz`)},
  nimbus: {revision:"e9f019ab4e40cb6037aff7e1a0eaf20842578ed3",archiveSha256:hash(`${work}/inputs/nimbus.tar.gz`)},
  toolchain: {wasiSdk:"25.0 arm64 Linux, clang 19.1.5",archiveSha256:hash(`${work}/inputs/wasi-sdk-25.tar.gz`),jobs:2},
  patches:[{path:"patches/0001-sed-wasi-fd-limit.patch",sha256:hash(`${here}/patches/0001-sed-wasi-fd-limit.patch`)}],
  artifact:{file:basename(output),bytes:bytes.length,sha256:hash(output)},
  imports:WebAssembly.Module.imports(module),exports:WebAssembly.Module.exports(module),
};
writeFileSync(`${output}.manifest.json`,JSON.stringify(manifest,null,2)+"\n");
console.log(JSON.stringify(manifest.artifact));
MANIFEST
