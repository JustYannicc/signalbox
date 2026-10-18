#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${1:?usage: build.sh <scratch directory>}"
mkdir -p "$WORK/downloads" "$WORK/output"
WORK="$(cd "$WORK" && pwd)"
IMAGE="node@sha256:14078204b6bb268c107ceff6d3c43f45a888105e5c2b18b14c32b3409d93a1b0"

fetch() {
  local url="$1" digest="$2" file="$WORK/downloads/$3"
  [ -f "$file" ] || curl -fsSL "$url" -o "$file"
  echo "$digest  $file" | shasum -a 256 -c -
}

fetch https://codeload.github.com/AshishKumar4/Nimbus/tar.gz/e9f019ab4e40cb6037aff7e1a0eaf20842578ed3 \
  f7024781c3dc2be1325efa1279aa9682cd84a2cd48f7782eb87ccd90ff0f1c12 nimbus.tgz
fetch https://ftp.gnu.org/gnu/bash/bash-5.2.37.tar.gz \
  9599b22ecd1d5787ad7d3b7bf0c59f312b3396d1e281175dd1f8a4014da621ff bash.tgz
fetch https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-25/wasi-sdk-25.0-arm64-linux.tar.gz \
  47fccad8b2498f2239e05e1115c3ffc652bf37e7de2f88fb64b2d663c976ce2d wasi-sdk.tgz
fetch https://github.com/WebAssembly/binaryen/releases/download/version_133/binaryen-version_133-aarch64-linux.tar.gz \
  89c07ea56faf38d0fbecf36ca8ec0721756716185f265b568e133d427f299bf8 binaryen.tgz
echo "4ea7a980f9ae121ab1382064ceabf91ead51f0735218a2bdeb372547297fc388  $HERE/patches/fd-getfd.patch" | shasum -a 256 -c -

docker run --rm -i --network none --platform linux/arm64 --cpus 2 --memory 4g \
  --tmpfs /build:rw,exec,size=2g \
  --mount "type=bind,source=$WORK/downloads,target=/downloads,readonly" \
  --mount "type=bind,source=$HERE,target=/recipe,readonly" \
  --mount "type=bind,source=$WORK/output,target=/output" \
  --env SOURCE_DATE_EPOCH=1727308800 --env TZ=UTC --env NIMBUS_BUILD_JOBS=2 \
  "$IMAGE" bash -s <<'BUILD'
set -euo pipefail
cd /build
tar xzf /downloads/nimbus.tgz
tar xzf /downloads/bash.tgz
tar xzf /downloads/wasi-sdk.tgz
tar xzf /downloads/binaryen.tgz
SHIM=/build/Nimbus-e9f019ab4e40cb6037aff7e1a0eaf20842578ed3/packages/worker/wasm/bash
patch -d "$SHIM" -p1 < /recipe/patches/fd-getfd.patch
export WASI_SDK=/build/wasi-sdk-25.0-arm64-linux
export BASH_SRC=/build/bash-5.2.37
export PATH="/build/binaryen-version_133/bin:$PATH"
bash "$SHIM/build-bash.sh"
cp "$SHIM/bash.async.wasm" /output/bash.async.wasm
cp "$BASH_SRC/COPYING" /output/GNU-Bash-COPYING
cp /build/Nimbus-e9f019ab4e40cb6037aff7e1a0eaf20842578ed3/LICENSE /output/Nimbus-LICENSE
cp "$SHIM/nimbus-proc.c" /output/nimbus-proc.c
node --input-type=module <<'MANIFEST'
import fs from 'node:fs';
import crypto from 'node:crypto';
const digest = path => crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');
const output = '/output/bash.async.wasm';
const module = new WebAssembly.Module(fs.readFileSync(output));
const manifest = {
  program: 'GNU Bash 5.2.37',
  programLicense: 'GPL-3.0-or-later',
  shimRepository: 'https://github.com/AshishKumar4/Nimbus',
  shimRevision: 'e9f019ab4e40cb6037aff7e1a0eaf20842578ed3',
  shimLicense: 'MIT',
  patch: { path: 'patches/fd-getfd.patch', sha256: digest('/recipe/patches/fd-getfd.patch') },
  recipeSha256: digest('/recipe/build.sh'),
  patchedShimSha256: digest('/output/nimbus-proc.c'),
  image: 'node@sha256:14078204b6bb268c107ceff6d3c43f45a888105e5c2b18b14c32b3409d93a1b0',
  inputs: Object.fromEntries(['nimbus', 'bash', 'wasi-sdk', 'binaryen'].map(name => [name, digest(`/downloads/${name}.tgz`)])),
  toolchain: { wasiSdk: '25.0 arm64 Linux', binaryen: '133 aarch64 Linux', jobs: 2 },
  output: { file: 'bash.async.wasm', sha256: digest(output), bytes: fs.statSync(output).size },
  imports: WebAssembly.Module.imports(module),
  exports: WebAssembly.Module.exports(module),
};
if (!manifest.imports.some(value => value.module === 'nimbus_proc' && value.name === 'fd_getfd'))
  throw new Error('Patched GNU Bash lacks nimbus_proc.fd_getfd');
fs.writeFileSync('/output/manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
MANIFEST
BUILD

echo "$WORK/output/manifest.json"
