#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${1:?usage: build.sh <scratch directory>}"
mkdir -p "$WORK/downloads" "$WORK/output"
WORK="$(cd "$WORK" && pwd)"
IMAGE="node@sha256:14078204b6bb268c107ceff6d3c43f45a888105e5c2b18b14c32b3409d93a1b0"

fetch() {
  local url="$1" digest="$2" file="$WORK/downloads/$3"
  if [ ! -f "$file" ]; then
    curl -fsSL "$url" -o "$file.part"
    mv "$file.part" "$file"
  fi
  echo "$digest  $file" | shasum -a 256 -c -
}

fetch https://codeload.github.com/AshishKumar4/Nimbus/tar.gz/e9f019ab4e40cb6037aff7e1a0eaf20842578ed3 \
  f7024781c3dc2be1325efa1279aa9682cd84a2cd48f7782eb87ccd90ff0f1c12 nimbus.tgz
fetch https://www.kernel.org/pub/software/scm/git/git-2.53.0.tar.xz \
  5818bd7d80b061bbbdfec8a433d609dc8818a05991f731ffc4a561e2ca18c653 git-2.53.0.tar.xz
fetch https://github.com/madler/zlib/releases/download/v1.3.1/zlib-1.3.1.tar.gz \
  9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23 zlib-1.3.1.tar.gz
fetch https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-25/wasi-sdk-25.0-arm64-linux.tar.gz \
  47fccad8b2498f2239e05e1115c3ffc652bf37e7de2f88fb64b2d663c976ce2d wasi-sdk.tgz
echo "$(shasum -a 256 "$HERE/patches/0001-startup-cwd.patch" | cut -d ' ' -f 1)  $HERE/patches/0001-startup-cwd.patch" | shasum -a 256 -c -

docker run --rm -i --network none --platform linux/arm64 --cpus 2 --memory 4g \
  --tmpfs /build:rw,exec,size=2g \
  --mount "type=bind,source=$WORK/downloads,target=/downloads,readonly" \
  --mount "type=bind,source=$HERE,target=/recipe,readonly" \
  --mount "type=bind,source=$WORK/output,target=/output" \
  --env SOURCE_DATE_EPOCH=1727308800 --env TZ=UTC \
  "$IMAGE" bash -s <<'BUILD'
set -euo pipefail
cd /build
tar xzf /downloads/nimbus.tgz
tar xzf /downloads/wasi-sdk.tgz
NIMBUS=/build/Nimbus-e9f019ab4e40cb6037aff7e1a0eaf20842578ed3
GIT_SHIM="$NIMBUS/packages/worker/wasm/git"
patch -d "$NIMBUS" -p1 < /recipe/patches/0001-startup-cwd.patch
# The pinned tarball has the verifier's zero-dependency workspace package but
# not the node_modules link the source checkout normally provides.
mkdir -p "$NIMBUS/node_modules/@nimbus-sh"
ln -s "$NIMBUS/packages/platform" "$NIMBUS/node_modules/@nimbus-sh/platform"
BUILD_DIR=/build/git-build
mkdir -p "$BUILD_DIR/src"
cp /downloads/git-2.53.0.tar.xz "$BUILD_DIR/src/git-2.53.0.tar.xz"
cp /downloads/zlib-1.3.1.tar.gz "$BUILD_DIR/src/zlib-1.3.1.tar.gz"
export WASI_SDK=/build/wasi-sdk-25.0-arm64-linux
export BUILD="$BUILD_DIR"
export GIT_BUILD_JOBS=2
bash "$GIT_SHIM/build-git.sh"
cp "$GIT_SHIM/git.wasm" /output/git.cwd.wasm
cp "$BUILD_DIR/src/git-2.53.0/COPYING" /output/Git-COPYING
cp "$NIMBUS/LICENSE" /output/Nimbus-LICENSE
cp "$NIMBUS/packages/worker/wasm/nimbus-libc/nimbus-proc.c" /output/nimbus-proc.c
node --input-type=module <<'MANIFEST'
import fs from 'node:fs';
import crypto from 'node:crypto';
const digest = path => crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');
const output = '/output/git.cwd.wasm';
const module = new WebAssembly.Module(fs.readFileSync(output));
const imports = WebAssembly.Module.imports(module);
const hasStartupCwd = imports.some(entry => entry.module === 'nimbus_proc' && entry.name === 'startup_cwd');
if (!hasStartupCwd) throw new Error('Rebuilt Git does not import nimbus_proc.startup_cwd');
const manifest = {
  program: 'Git 2.53.0',
  programLicense: 'GPL-2.0-only',
  shimRepository: 'https://github.com/AshishKumar4/Nimbus',
  shimRevision: 'e9f019ab4e40cb6037aff7e1a0eaf20842578ed3',
  shimLicense: 'MIT',
  patch: { path: 'patches/0001-startup-cwd.patch', sha256: digest('/recipe/patches/0001-startup-cwd.patch') },
  recipeSha256: digest('/recipe/build.sh'),
  patchedShimSha256: digest('/output/nimbus-proc.c'),
  image: 'node@sha256:14078204b6bb268c107ceff6d3c43f45a888105e5c2b18b14c32b3409d93a1b0',
  inputs: {
    nimbus: digest('/downloads/nimbus.tgz'),
    git: digest('/downloads/git-2.53.0.tar.xz'),
    zlib: digest('/downloads/zlib-1.3.1.tar.gz'),
    wasiSdk: digest('/downloads/wasi-sdk.tgz'),
  },
  toolchain: { wasiSdk: '25.0 arm64 Linux', jobs: 2 },
  output: { file: 'git.cwd.wasm', sha256: digest(output), bytes: fs.statSync(output).size },
  imports,
  exports: WebAssembly.Module.exports(module),
};
fs.writeFileSync('/output/manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
MANIFEST
BUILD

cat "$WORK/output/manifest.json"
