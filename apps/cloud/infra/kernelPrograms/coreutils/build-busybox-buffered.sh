#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
WORK_ROOT="${1:?usage: build-busybox-buffered.sh <fresh work root> <artifact output>}"
ARTIFACT_OUTPUT="${2:?usage: build-busybox-buffered.sh <fresh work root> <artifact output>}"
WORK_ROOT="$(mkdir -p "$WORK_ROOT" && cd -- "$WORK_ROOT" && pwd -P)"
OUTPUT_DIR="$(mkdir -p "$(dirname -- "$ARTIFACT_OUTPUT")" && cd -- "$(dirname -- "$ARTIFACT_OUTPUT")" && pwd -P)"
ARTIFACT_OUTPUT="$OUTPUT_DIR/$(basename -- "$ARTIFACT_OUTPUT")"

fail() {
  echo "BusyBox buffered build: $*" >&2
  exit 1
}

[[ "$ARTIFACT_OUTPUT" != "$HERE/bin/"* ]] || fail "refusing to overwrite the packaged artifact"
RUN_ROOT="$WORK_ROOT/run"
[[ ! -e "$RUN_ROOT" ]] || fail "work root is not fresh: $RUN_ROOT"

NIMBUS_COMMIT="e9f019ab4e40cb6037aff7e1a0eaf20842578ed3"
NIMBUS_ARCHIVE_SHA="f7024781c3dc2be1325efa1279aa9682cd84a2cd48f7782eb87ccd90ff0f1c12"
BUSYBOX_VERSION="1.37.0"
BUSYBOX_ARCHIVE_SHA="3311dff32e746499f4df0d5df04d7eb396382d7e108bb9250e7b519b837043a4"
WASI_SDK_ARCHIVE_SHA="e1e529ea226b1db0b430327809deae9246b580fa3cae32d31c82dfe770233587"
BUILD_JOBS="${BUILD_JOBS:-2}"
SOURCE_CACHE_DIR="${SOURCE_CACHE_DIR:-}"

INPUTS="$RUN_ROOT/inputs"
NIMBUS_SOURCE="$RUN_ROOT/nimbus"
BUSYBOX_SOURCE="$RUN_ROOT/busybox"
WASI_SDK_ROOT="$RUN_ROOT/wasi-sdk"
TOOLS="$RUN_ROOT/tools"
mkdir -p "$INPUTS" "$NIMBUS_SOURCE" "$BUSYBOX_SOURCE" "$WASI_SDK_ROOT" "$TOOLS"

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

sha256() {
  shasum -a 256 "$1" | awk '{print $1}'
}

fetch() {
  local url="$1" output="$2" expected="$3" cache_path="${4:-}" actual
  if [[ -n "$cache_path" && -f "$cache_path" ]]; then
    cp "$cache_path" "$output"
  else
    curl --fail --location --silent --show-error "$url" --output "$output"
  fi
  actual="$(sha256 "$output")"
  [[ "$actual" == "$expected" ]] || fail "SHA-256 mismatch for $output: expected $expected, got $actual"
}

for command in awk curl git make node patch shasum tar; do need "$command"; done
if command -v gsed >/dev/null 2>&1; then
  ln -s "$(command -v gsed)" "$TOOLS/sed"
elif [[ "$(sed --version 2>/dev/null | head -n 1)" == *GNU* ]]; then
  ln -s "$(command -v sed)" "$TOOLS/sed"
else
  fail "GNU sed is required to run the pinned Nimbus recipe on this host"
fi
cat > "$TOOLS/nproc" <<'NPROC'
#!/usr/bin/env sh
echo "${BUILD_JOBS:-2}"
NPROC
chmod +x "$TOOLS/nproc"
cat > "$TOOLS/wasm32-wasi-ar" <<'WASI_AR'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$#" == 2 && "$1" == "rcs" ]]; then
  printf '!<arch>\n' > "$2"
else
  exec "$WASI_AR_REAL" "$@"
fi
WASI_AR
chmod +x "$TOOLS/wasm32-wasi-ar"

NIMBUS_TARBALL="$INPUTS/nimbus.tar.gz"
BUSYBOX_TARBALL="$INPUTS/busybox.tar.bz2"
WASI_SDK_TARBALL="$INPUTS/wasi-sdk.tar.gz"
fetch "https://codeload.github.com/AshishKumar4/Nimbus/tar.gz/$NIMBUS_COMMIT" \
  "$NIMBUS_TARBALL" "$NIMBUS_ARCHIVE_SHA" "${SOURCE_CACHE_DIR:+$SOURCE_CACHE_DIR/Nimbus-e9f019ab.tar.gz}"
fetch "https://busybox.net/downloads/busybox-$BUSYBOX_VERSION.tar.bz2" \
  "$BUSYBOX_TARBALL" "$BUSYBOX_ARCHIVE_SHA" "${SOURCE_CACHE_DIR:+$SOURCE_CACHE_DIR/busybox-1.37.0.tar.bz2}"
fetch "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-25/wasi-sdk-25.0-arm64-macos.tar.gz" \
  "$WASI_SDK_TARBALL" "$WASI_SDK_ARCHIVE_SHA"

tar -xzf "$NIMBUS_TARBALL" -C "$NIMBUS_SOURCE" --strip-components=1
tar -xjf "$BUSYBOX_TARBALL" -C "$BUSYBOX_SOURCE" --strip-components=1
git -C "$BUSYBOX_SOURCE" apply --check "$HERE/patches/0004-busybox-1m-copy-buffer.patch"
git -C "$BUSYBOX_SOURCE" apply "$HERE/patches/0004-busybox-1m-copy-buffer.patch"
git -C "$NIMBUS_SOURCE" apply --check "$HERE/patches/0006-busybox-target-ar.patch"
git -C "$NIMBUS_SOURCE" apply "$HERE/patches/0006-busybox-target-ar.patch"
tar -xzf "$WASI_SDK_TARBALL" -C "$WASI_SDK_ROOT" --strip-components=1

export PATH="$TOOLS:$PATH"
export BUILD_JOBS SOURCE_DATE_EPOCH=1727308800 TZ=UTC LC_ALL=C
export WASI_SDK="$WASI_SDK_ROOT" WASI_AR_REAL="$WASI_SDK_ROOT/bin/llvm-ar"
export BUSYBOX_SRC="$BUSYBOX_SOURCE"
export AR="$TOOLS/wasm32-wasi-ar"
BUILD_RECIPE="$NIMBUS_SOURCE/packages/worker/wasm/bash/coreutils/build-busybox.sh"
if ! AR="$TOOLS/wasm32-wasi-ar" bash "$BUILD_RECIPE" > "$RUN_ROOT/build.log" 2>&1; then
  tail -n 100 "$RUN_ROOT/build.log" >&2
  fail "pinned BusyBox build failed"
fi

CONFIGURED_BUFFER="$(sed -n 's/^CONFIG_FEATURE_COPYBUF_KB=//p' "$BUSYBOX_SOURCE/.config")"
[[ "$CONFIGURED_BUFFER" == "1024" ]] || fail "BusyBox buffer configuration is $CONFIGURED_BUFFER KiB, expected 1024"
cp "$NIMBUS_SOURCE/packages/worker/wasm/bash/coreutils/busybox.wasm" "$ARTIFACT_OUTPUT"
ARTIFACT_SHA="$(sha256 "$ARTIFACT_OUTPUT")"
ARTIFACT_BYTES="$(wc -c < "$ARTIFACT_OUTPUT" | tr -d ' ')"

NIMBUS_COMMIT="$NIMBUS_COMMIT" NIMBUS_TARBALL="$NIMBUS_TARBALL" \
  BUSYBOX_TARBALL="$BUSYBOX_TARBALL" WASI_SDK_TARBALL="$WASI_SDK_TARBALL" \
  BUILD_RECIPE="$BUILD_RECIPE" BUFFER_PATCH="$HERE/patches/0004-busybox-1m-copy-buffer.patch" \
  AR_PATCH="$HERE/patches/0006-busybox-target-ar.patch" \
  ARTIFACT_OUTPUT="$ARTIFACT_OUTPUT" ARTIFACT_SHA="$ARTIFACT_SHA" \
  ARTIFACT_BYTES="$ARTIFACT_BYTES" CONFIGURED_BUFFER="$CONFIGURED_BUFFER" node --input-type=module <<'MANIFEST'
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashFile = (path) => digest(readFileSync(path));
const artifact = readFileSync(process.env.ARTIFACT_OUTPUT);
const module = new WebAssembly.Module(artifact);
const imports = WebAssembly.Module.imports(module)
  .map(({ module, name, kind }) => `${module}.${name}:${kind}`)
  .sort();
const exports = WebAssembly.Module.exports(module)
  .map(({ name, kind }) => `${name}:${kind}`)
  .sort();
const manifest = {
  schemaVersion: 1,
  source: {
    repository: "https://github.com/AshishKumar4/Nimbus",
    commit: process.env.NIMBUS_COMMIT,
    nimbusArchiveSha256: hashFile(process.env.NIMBUS_TARBALL),
    busyboxVersion: "1.37.0",
    busyboxArchiveSha256: hashFile(process.env.BUSYBOX_TARBALL),
    buildRecipe: "packages/worker/wasm/bash/coreutils/build-busybox.sh",
    buildRecipeSha256: hashFile(process.env.BUILD_RECIPE),
    buildRecipePatch: {
      path: "patches/0006-busybox-target-ar.patch",
      sha256: hashFile(process.env.AR_PATCH),
    },
    bufferPatch: {
      path: "patches/0004-busybox-1m-copy-buffer.patch",
      sha256: hashFile(process.env.BUFFER_PATCH),
    },
  },
  toolchain: {
    wasiSdk: "25.0 arm64 macOS, clang 19.1.5",
    wasiSdkArchiveSha256: hashFile(process.env.WASI_SDK_TARBALL),
    configuredCopyBufferKiB: Number(process.env.CONFIGURED_BUFFER),
    jobs: Number(process.env.BUILD_JOBS),
  },
  artifact: {
    file: basename(process.env.ARTIFACT_OUTPUT),
    sha256: process.env.ARTIFACT_SHA,
    bytes: Number(process.env.ARTIFACT_BYTES),
    imports,
    exports,
  },
};
writeFileSync(
  join(dirname(process.env.ARTIFACT_OUTPUT), "busybox.manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
MANIFEST

printf 'busybox.wasm %s bytes %s\n' "$ARTIFACT_BYTES" "$ARTIFACT_SHA"
