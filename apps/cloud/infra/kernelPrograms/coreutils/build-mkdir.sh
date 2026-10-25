#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
WORK_ROOT="${1:?usage: build-mkdir.sh <fresh work root> <artifact output> }"
ARTIFACT_OUTPUT="${2:?usage: build-mkdir.sh <fresh work root> <artifact output> }"
WORK_ROOT="$(mkdir -p "$WORK_ROOT" && cd -- "$WORK_ROOT" && pwd -P)"
OUTPUT_DIR="$(mkdir -p "$(dirname -- "$ARTIFACT_OUTPUT")" && cd -- "$(dirname -- "$ARTIFACT_OUTPUT")" && pwd -P)"
ARTIFACT_OUTPUT="$OUTPUT_DIR/$(basename -- "$ARTIFACT_OUTPUT")"

fail() {
  echo "coreutils mkdir build: $*" >&2
  exit 1
}

[[ "$ARTIFACT_OUTPUT" != "$HERE/bin/"* ]] || fail "refusing to overwrite the packaged artifact"
RUN_ROOT="$WORK_ROOT/run"
[[ ! -e "$RUN_ROOT" ]] || fail "work root is not fresh: $RUN_ROOT"

AGENTOS_COMMIT="63ae3b256749d47c7b3a7c463128d5deda57d1bb"
AGENTOS_ARCHIVE_SHA="2c95943fdad51df8a269344c6cc6dad1ee316b216340ff281d3d8a636bd5257e"
WASI_LIBC_COMMIT="574b88da481569b65a237cb80daf9a2d5aeaf82d"
WASI_LIBC_ARCHIVE_SHA="7d11a801570972e7f32639eed3f8f7d0e997f276b3c85b7aa03283e1265e4b8e"
WASI_SDK_ARCHIVE_SHA="e1e529ea226b1db0b430327809deae9246b580fa3cae32d31c82dfe770233587"
RUST_TOOLCHAIN="nightly-2026-03-01"
RUSTC_COMMIT="38c0de8dcb14d42290042521be9958d37f3fa390"
RUSTC_VERSION="1.96.0-nightly (38c0de8dc 2026-02-28)"
CARGO_VERSION="1.96.0-nightly (f298b8c82 2026-02-24)"
CARGO_LOCK_SHA="d802e679dd3d82781f3caa07a71441fc039efc385f5b2af6c2420ebe4010fdf5"
UMASK_SOURCE_SHA="64354173e28505c2433773873f799bcc4ff4fc6f70365a1e51051d7533dc6585"
EXPECTED_EFFECTIVE_CARGO_LOCK_SHA="fd79973e2c84314051e3776acb915a560a366b0cf1c143003804d82c264aa055"
EXPECTED_LIBC_ARCHIVE_SHA="d37e187e1988e07f076f244ed339eeaeda0405efbab4611328ad4b265ee9f992"

INPUTS="$RUN_ROOT/inputs"
AGENTOS_SOURCE="$RUN_ROOT/agentos"
WASI_LIBC_SOURCE="$RUN_ROOT/wasi-libc"
WASI_SDK_ROOT="$RUN_ROOT/wasi-sdk"
SYSROOT="$RUN_ROOT/sysroot"
SYSROOT_LIB="$SYSROOT/lib/wasm32-wasi"
WASI_LIBC_OBJ="$RUN_ROOT/wasi-libc-obj"
RUSTUP_HOME="$RUN_ROOT/rustup-home"
CARGO_HOME="$RUN_ROOT/cargo-home"
TARGET_DIR="$RUN_ROOT/target"
mkdir -p "$INPUTS" "$AGENTOS_SOURCE" "$WASI_LIBC_SOURCE" "$WASI_SDK_ROOT" \
  "$SYSROOT" "$WASI_LIBC_OBJ" "$RUSTUP_HOME" "$CARGO_HOME" "$TARGET_DIR"

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

sha256() {
  shasum -a 256 "$1" | awk '{print $1}'
}

assert_sha256() {
  local path="$1" expected="$2" actual
  actual="$(sha256 "$path")"
  [[ "$actual" == "$expected" ]] || fail "SHA-256 mismatch for $path: expected $expected, got $actual"
}

fetch() {
  local url="$1" output="$2" expected="$3"
  curl --fail --location --silent --show-error "$url" --output "$output"
  assert_sha256 "$output" "$expected"
}

for command in awk cargo curl git make node patch rustup shasum tar; do need "$command"; done

AGENTOS_TARBALL="$INPUTS/agentos.tar.gz"
WASI_LIBC_TARBALL="$INPUTS/wasi-libc.tar.gz"
WASI_SDK_TARBALL="$INPUTS/wasi-sdk.tar.gz"
fetch "https://codeload.github.com/rivet-dev/agentos/tar.gz/$AGENTOS_COMMIT" \
  "$AGENTOS_TARBALL" "$AGENTOS_ARCHIVE_SHA"
fetch "https://codeload.github.com/WebAssembly/wasi-libc/tar.gz/$WASI_LIBC_COMMIT" \
  "$WASI_LIBC_TARBALL" "$WASI_LIBC_ARCHIVE_SHA"
fetch "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-25/wasi-sdk-25.0-arm64-macos.tar.gz" \
  "$WASI_SDK_TARBALL" "$WASI_SDK_ARCHIVE_SHA"

tar -xzf "$AGENTOS_TARBALL" -C "$AGENTOS_SOURCE" --strip-components=1
tar -xzf "$WASI_LIBC_TARBALL" -C "$WASI_LIBC_SOURCE" --strip-components=1
assert_sha256 "$AGENTOS_SOURCE/toolchain/Cargo.lock" "$CARGO_LOCK_SHA"
assert_sha256 "$AGENTOS_SOURCE/toolchain/std-patches/wasi-libc-overrides/umask.c" "$UMASK_SOURCE_SHA"

SOURCE_PATCH="$HERE/patches/0001-use-proc-umask-on-wasi.patch"
MKDIR_PATCH="$HERE/patches/0002-mkdir-wasi-mode.patch"
git -C "$AGENTOS_SOURCE" apply --check "$SOURCE_PATCH"
git -C "$AGENTOS_SOURCE" apply "$SOURCE_PATCH"

while IFS= read -r patch_file; do
  git -C "$WASI_LIBC_SOURCE" apply --check "$patch_file"
  git -C "$WASI_LIBC_SOURCE" apply "$patch_file"
done < <(find "$AGENTOS_SOURCE/toolchain/std-patches/wasi-libc" -maxdepth 1 -name '*.patch' -type f | sort)

export RUSTUP_HOME CARGO_HOME
rustup toolchain install "$RUST_TOOLCHAIN" --profile minimal --target wasm32-wasip1 \
  --component rust-src --no-self-update > "$RUN_ROOT/rustup.log" 2>&1 || {
  tail -n 40 "$RUN_ROOT/rustup.log" >&2
  fail "could not install the pinned Rust toolchain"
}
TOOLCHAIN_HOME="$RUSTUP_HOME/toolchains/$RUST_TOOLCHAIN-aarch64-apple-darwin"
RUSTC="$TOOLCHAIN_HOME/bin/rustc"
CARGO="$TOOLCHAIN_HOME/bin/cargo"
RUSTC_VERBOSE="$($RUSTC --version --verbose)"
[[ "$($RUSTC --version)" == "rustc $RUSTC_VERSION" ]] || fail "rustc version differs from pin"
[[ "$RUSTC_VERBOSE" == *"commit-hash: $RUSTC_COMMIT"* ]] || fail "rustc commit differs from pin"
[[ "$($CARGO --version)" == "cargo $CARGO_VERSION" ]] || fail "Cargo version differs from pin"

export PATH="$TOOLCHAIN_HOME/bin:$PATH"
export SOURCE_DATE_EPOCH=0 TZ=UTC LC_ALL=C CARGO_INCREMENTAL=0
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL="$RUN_ROOT/gitconfig" GIT_CEILING_DIRECTORIES="$RUN_ROOT"
unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE || true
: > "$GIT_CONFIG_GLOBAL"

if ! bash "$AGENTOS_SOURCE/toolchain/scripts/patch-std.sh" > "$RUN_ROOT/patch-std.log" 2>&1; then
  tail -n 50 "$RUN_ROOT/patch-std.log" >&2
  fail "Rust std patches failed"
fi
if ! make -C "$AGENTOS_SOURCE/toolchain" vendor > "$RUN_ROOT/vendor.log" 2>&1; then
  tail -n 60 "$RUN_ROOT/vendor.log" >&2
  fail "Cargo dependencies could not be vendored"
fi
git -C "$AGENTOS_SOURCE" apply --check "$MKDIR_PATCH"
git -C "$AGENTOS_SOURCE" apply "$MKDIR_PATCH"
if ! make -C "$AGENTOS_SOURCE/toolchain" patch-vendor > "$RUN_ROOT/patch-vendor.log" 2>&1; then
  tail -n 60 "$RUN_ROOT/patch-vendor.log" >&2
  fail "Cargo vendor patches could not be applied"
fi
AGENTOS_SOURCE="$AGENTOS_SOURCE" node --input-type=module <<'CHECKSUM'
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
const vendorRoot = `${process.env.AGENTOS_SOURCE}/toolchain/vendor/uu_mkdir`;
const source = `${vendorRoot}/src/mkdir.rs`;
const checksumPath = `${vendorRoot}/.cargo-checksum.json`;
const checksum = JSON.parse(readFileSync(checksumPath, "utf8"));
checksum.files["src/mkdir.rs"] = createHash("sha256").update(readFileSync(source)).digest("hex");
writeFileSync(checksumPath, `${JSON.stringify(checksum)}\n`);
CHECKSUM

tar -xzf "$WASI_SDK_TARBALL" -C "$WASI_SDK_ROOT" --strip-components=1
WASI_CC="$WASI_SDK_ROOT/bin/clang"
WASI_AR="$WASI_SDK_ROOT/bin/llvm-ar"
WASI_NM="$WASI_SDK_ROOT/bin/llvm-nm"
mkdir -p "$WASI_LIBC_OBJ"
if ! make -C "$WASI_LIBC_SOURCE" -j2 \
  "$WASI_LIBC_OBJ/copy-startup-files.stamp" libc \
  "CC=$WASI_CC" "AR=$WASI_AR" "NM=$WASI_NM" "SYSROOT=$SYSROOT" \
  "OBJDIR=$WASI_LIBC_OBJ" "EXTRA_CFLAGS=-O2 -DNDEBUG" "THREAD_MODEL=single" \
  > "$RUN_ROOT/wasi-libc.log" 2>&1; then
  tail -n 60 "$RUN_ROOT/wasi-libc.log" >&2
  fail "patched wasi-libc build failed"
fi

for symbol in accept send recv select poll getsockopt ioctl sigaction signal; do
  member="$($WASI_NM --print-file-name "$SYSROOT_LIB/libc.a" 2>/dev/null | \
    awk -v symbol="$symbol" '$NF == symbol && $(NF-1) ~ /^[TW]$/ && member == "" { split($1, path, ":"); member = path[2] } END { if (member != "") print member }')"
  [[ -z "$member" ]] || "$WASI_AR" d "$SYSROOT_LIB/libc.a" "$member"
done

for runtime in "$WASI_SDK_ROOT"/share/wasi-sysroot/lib/wasm32-wasi/crt*.o; do
  [[ -f "$runtime" ]] && cp "$runtime" "$SYSROOT_LIB/"
done
for subdir in include lib; do
  [[ -e "$SYSROOT/$subdir/wasm32-wasip1" ]] || ln -s wasm32-wasi "$SYSROOT/$subdir/wasm32-wasip1"
done
OVERRIDE_DIR="$AGENTOS_SOURCE/toolchain/std-patches/wasi-libc-overrides"
for source in "$OVERRIDE_DIR"/*.c; do
  name="$(basename "${source%.c}")"
  if [[ "$name" == pthread_key ]]; then
    "$WASI_CC" --target=wasm32-wasip1 --sysroot="$SYSROOT" -O2 -D_GNU_SOURCE \
      -I"$AGENTOS_SOURCE/toolchain/c/include" \
      -I"$WASI_LIBC_SOURCE/libc-top-half/musl/src/internal" \
      -I"$WASI_LIBC_SOURCE/libc-top-half/musl/arch/wasm32" \
      -c "$source" -o "$SYSROOT_LIB/override_$name.o"
  else
    "$WASI_CC" --target=wasm32-wasip1 --sysroot="$SYSROOT" -O2 -D_GNU_SOURCE \
      -I"$AGENTOS_SOURCE/toolchain/c/include" -c "$source" \
      -o "$SYSROOT_LIB/override_$name.o"
  fi
  "$WASI_AR" r "$SYSROOT_LIB/libc.a" "$SYSROOT_LIB/override_$name.o"
  rm "$SYSROOT_LIB/override_$name.o"
done
for library in m rt pthread crypt util xnet resolv; do "$WASI_AR" crs "$SYSROOT_LIB/lib$library.a"; done

LIBC_SHA="$(sha256 "$SYSROOT_LIB/libc.a")"
[[ "$LIBC_SHA" == "$EXPECTED_LIBC_ARCHIVE_SHA" ]] || fail "patched wasi-libc archive differs from pin"
export RUSTC CC_wasm32_wasip1="$WASI_CC" AR_wasm32_wasip1="$WASI_AR"
export CFLAGS_wasm32_wasip1="--sysroot=$SYSROOT" CARGO_TARGET_DIR="$TARGET_DIR"
export RUSTFLAGS="-C codegen-units=1 -C link-self-contained=no -C link-arg=$SYSROOT_LIB/crt1-command.o -C link-arg=$SYSROOT_LIB/libc.a -C link-arg=$SYSROOT_LIB/libwasi-emulated-pthread.a -C link-arg=-L$SYSROOT_LIB -C metadata=agentos-libc-${LIBC_SHA:0:16} --cfg tokio_unstable --remap-path-prefix=$RUN_ROOT=/signalbox/coreutils-build --remap-path-prefix=$AGENTOS_SOURCE=/signalbox/agentos --remap-path-prefix=$RUSTUP_HOME=/signalbox/rustup --remap-path-prefix=$CARGO_HOME=/signalbox/cargo"

if ! (cd "$AGENTOS_SOURCE/toolchain" && "$CARGO" build \
  --manifest-path "../software/coreutils/native/crates/cmd-mkdir/Cargo.toml" \
  --target wasm32-wasip1 --release --offline --jobs 1 -Z build-std=std,panic_abort) \
  > "$RUN_ROOT/cargo-build.log" 2>&1; then
  tail -n 80 "$RUN_ROOT/cargo-build.log" >&2
  fail "mkdir cross-build failed"
fi

BUILT_ARTIFACT="$TARGET_DIR/wasm32-wasip1/release/mkdir.wasm"
[[ -f "$BUILT_ARTIFACT" ]] || fail "cargo did not produce mkdir.wasm"
assert_sha256 "$AGENTOS_SOURCE/toolchain/Cargo.lock" "$EXPECTED_EFFECTIVE_CARGO_LOCK_SHA"
cp "$BUILT_ARTIFACT" "$ARTIFACT_OUTPUT"
ARTIFACT_SHA="$(sha256 "$ARTIFACT_OUTPUT")"
ARTIFACT_BYTES="$(wc -c < "$ARTIFACT_OUTPUT" | tr -d ' ')"

AGENTOS_SOURCE="$AGENTOS_SOURCE" WASI_LIBC_SOURCE="$WASI_LIBC_SOURCE" SOURCE_PATCH="$SOURCE_PATCH" MKDIR_PATCH="$MKDIR_PATCH" \
  WASI_LIBC_TARBALL="$WASI_LIBC_TARBALL" WASI_SDK_TARBALL="$WASI_SDK_TARBALL" \
  AGENTOS_TARBALL="$AGENTOS_TARBALL" SYSROOT_LIB="$SYSROOT_LIB" ARTIFACT_OUTPUT="$ARTIFACT_OUTPUT" \
  ARTIFACT_SHA="$ARTIFACT_SHA" ARTIFACT_BYTES="$ARTIFACT_BYTES" TOOLCHAIN_HOME="$TOOLCHAIN_HOME" BUILD_SCRIPT="$HERE/build-mkdir.sh" \
  RUSTC_COMMIT="$RUSTC_COMMIT" RUSTC_VERSION="$RUSTC_VERSION" CARGO_VERSION="$CARGO_VERSION" \
  RUST_TOOLCHAIN="$RUST_TOOLCHAIN" WASI_LIBC_COMMIT="$WASI_LIBC_COMMIT" AGENTOS_COMMIT="$AGENTOS_COMMIT" \
  node --input-type=module <<'MANIFEST'
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashFile = (path) => digest(readFileSync(path));
const sourcePatch = process.env.SOURCE_PATCH;
const agentosSource = process.env.AGENTOS_SOURCE;
const wasiLibcSource = process.env.WASI_LIBC_SOURCE;
const artifactPath = process.env.ARTIFACT_OUTPUT;
const artifactBytes = readFileSync(artifactPath);
const module = new WebAssembly.Module(artifactBytes);
const imports = WebAssembly.Module.imports(module)
  .map(({ module, name, kind }) => ({ module, name, kind }))
  .sort((a, b) => `${a.module}.${a.name}`.localeCompare(`${b.module}.${b.name}`));
const exports = WebAssembly.Module.exports(module)
  .map(({ name, kind }) => ({ name, kind }))
  .sort((a, b) => a.name.localeCompare(b.name));
if (!imports.some(({ module, name }) => module === "host_process" && name === "proc_umask")) {
  throw new Error("Rebuilt mkdir does not import host_process.proc_umask");
}
if (!imports.some(({ module, name }) => module === "host_fs" && name === "chmod")) {
  throw new Error("Rebuilt mkdir does not import host_fs.chmod");
}
const patches = readdirSync(join(agentosSource, "toolchain/std-patches/wasi-libc"))
  .filter((name) => name.endsWith(".patch"))
  .sort()
  .map((name) => ({ path: `toolchain/std-patches/wasi-libc/${name}`, sha256: hashFile(join(agentosSource, "toolchain/std-patches/wasi-libc", name)) }));
const overrides = readdirSync(join(agentosSource, "toolchain/std-patches/wasi-libc-overrides"))
  .filter((name) => name.endsWith(".c"))
  .sort()
  .map((name) => ({ path: `toolchain/std-patches/wasi-libc-overrides/${name}`, sha256: hashFile(join(agentosSource, "toolchain/std-patches/wasi-libc-overrides", name)) }));
const manifest = {
  schemaVersion: 1,
  source: {
    repository: "https://github.com/rivet-dev/agentos",
    commit: process.env.AGENTOS_COMMIT,
    archiveSha256: hashFile(process.env.AGENTOS_TARBALL),
    command: "software/coreutils/native/crates/cmd-mkdir",
    uutilsVersion: "0.7.0",
    patch: { path: "patches/0001-use-proc-umask-on-wasi.patch", sha256: hashFile(sourcePatch) },
    commandPatch: { path: "patches/0002-mkdir-wasi-mode.patch", sha256: hashFile(process.env.MKDIR_PATCH) },
    cargoLockSha256: hashFile(join(agentosSource, "toolchain/Cargo.lock")),
    inputCargoLockSha256: "d802e679dd3d82781f3caa07a71441fc039efc385f5b2af6c2420ebe4010fdf5",
    recipeSha256: hashFile(process.env.BUILD_SCRIPT),
  },
  wasiLibc: {
    commit: process.env.WASI_LIBC_COMMIT,
    archiveSha256: hashFile(process.env.WASI_LIBC_TARBALL),
    patches,
    overrides,
    compiledOverride: "toolchain/std-patches/wasi-libc-overrides/umask.c",
    compiledOverrideSha256: hashFile(join(agentosSource, "toolchain/std-patches/wasi-libc-overrides/umask.c")),
    libcArchiveSha256: hashFile(join(process.env.SYSROOT_LIB, "libc.a")),
  },
  toolchain: {
    rustChannel: process.env.RUST_TOOLCHAIN,
    rustc: process.env.RUSTC_VERSION,
    rustcCommit: process.env.RUSTC_COMMIT,
    cargo: process.env.CARGO_VERSION,
    target: "wasm32-wasip1",
    wasiSdk: "25.0 arm64 macOS, clang 19.1.5",
    wasiSdkArchiveSha256: hashFile(process.env.WASI_SDK_TARBALL),
    jobs: 1,
  },
  artifact: {
    file: basename(artifactPath),
    sha256: process.env.ARTIFACT_SHA,
    bytes: Number(process.env.ARTIFACT_BYTES),
    imports,
    exports,
  },
};
writeFileSync(join(dirname(artifactPath), "mkdir.manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
MANIFEST

printf 'mkdir.wasm %s bytes %s\n' "$ARTIFACT_BYTES" "$ARTIFACT_SHA"
