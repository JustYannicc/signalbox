#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROVENANCE="$SCRIPT_DIR/provenance.json"
BUILD_ROOT="${RIPGREP_BUILD_ROOT:-$SCRIPT_DIR/.build}"
mkdir -p "$BUILD_ROOT"
BUILD_ROOT="$(cd -- "$BUILD_ROOT" && pwd -P)"
RUN_ROOT="$BUILD_ROOT/$(date -u +%Y%m%dT%H%M%SZ)-$$"
INPUTS="$RUN_ROOT/inputs"
PATCHES="$RUN_ROOT/patches"
SYSROOT="$RUN_ROOT/wasi-libc-sysroot"
WASI_LIBC_OBJ="$RUN_ROOT/wasi-libc-obj"
TARGET_DIR="$RUN_ROOT/target-stock-std"
CRATE_CACHE="$RUN_ROOT/cargo-home"
RUSTUP_HOME="$RUN_ROOT/rustup-home"
mkdir -p "$INPUTS" "$PATCHES" "$SYSROOT" "$WASI_LIBC_OBJ" "$CRATE_CACHE" "$RUSTUP_HOME"

fail() {
  echo "ripgrep build: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

for command in curl git make node patch rustup tar; do need "$command"; done

: "${WASI_SDK_ROOT:?Set WASI_SDK_ROOT to the pinned wasi-sdk 24 installation (clang 19.1.5).}"
WASI_SDK_ROOT="$(cd -- "$WASI_SDK_ROOT" && pwd -P)"
CLANG="$WASI_SDK_ROOT/bin/clang"
LLVM_AR="$WASI_SDK_ROOT/bin/llvm-ar"
LLVM_NM="$WASI_SDK_ROOT/bin/llvm-nm"
for tool in "$CLANG" "$LLVM_AR" "$LLVM_NM"; do
  [[ -x "$tool" ]] || fail "missing executable: $tool"
done

pin() {
  node -e 'const fs = require("node:fs"); let value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); for (const key of process.argv.slice(2)) value = value[key]; if (value === undefined || (typeof value === "object" && value !== null)) process.exit(2); console.log(value);' "$PROVENANCE" "$@"
}

artifact_records() {
  node -e 'const fs = require("node:fs"); let value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); for (const key of process.argv[2].split(".")) value = value[key]; for (const item of value) console.log(`${item.path}\t${item.sha256}`);' "$PROVENANCE" "$1"
}

patch_records() {
  node -e 'const fs = require("node:fs"); let value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); for (const key of process.argv[2].split(".")) value = value[key]; for (const item of value) console.log(`${item.file}\t${item.sha256}`);' "$PROVENANCE" "$1"
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    fail "sha256sum or shasum is required"
  fi
}

assert_sha256() {
  local file="$1" expected="$2" actual
  [[ -f "$file" ]] || fail "missing pinned input: $file"
  actual="$(sha256 "$file")"
  [[ "$actual" == "$expected" ]] || fail "SHA-256 mismatch for $file: expected $expected, got $actual"
}

download() {
  local url="$1" file="$2" expected="$3"
  curl --fail --location --silent --show-error --retry 3 "$url" --output "$file"
  assert_sha256 "$file" "$expected"
}

RIPGREP_VERSION="$(pin source version)"
RIPGREP_ARCHIVE_SHA="$(pin source archiveSha256)"
CARGO_LOCK_SHA="$(pin source cargoLockFile sha256)"
WASI_LIBC_COMMIT="$(pin wasiLibc baseCommit)"
AGENTOS_COMMIT="$(pin toolchain agentOsCommit)"
RUST_TOOLCHAIN="$(pin toolchain rustChannel)"
RUSTC_COMMIT="$(pin toolchain rustcCommit)"
RUSTC_RELEASE="$(pin toolchain rustc)"
CARGO_RELEASE="$(pin toolchain cargo)"
CLANG_RELEASE="$(pin toolchain wasiSdk clang)"
LLVM_COMMIT="$(pin toolchain wasiSdk llvmCommit)"
EXPECTED_ARTIFACT_BYTES="$(pin artifact bytes)"
EXPECTED_ARTIFACT_SHA="$(pin artifact sha256)"
DEFAULT_ARTIFACT_OUTPUT="$SCRIPT_DIR/bin/rg.wasm"
ARTIFACT_OUTPUT="${RIPGREP_ARTIFACT_OUTPUT:-$DEFAULT_ARTIFACT_OUTPUT}"
ARTIFACT_OUTPUT_DIR="$(dirname -- "$ARTIFACT_OUTPUT")"
mkdir -p "$ARTIFACT_OUTPUT_DIR"
ARTIFACT_OUTPUT_DIR="$(cd -- "$ARTIFACT_OUTPUT_DIR" && pwd -P)"
ARTIFACT_OUTPUT="$ARTIFACT_OUTPUT_DIR/$(basename -- "$ARTIFACT_OUTPUT")"
DISCOVER_ARTIFACT=false
if [[ "${RIPGREP_EXPECT_ARTIFACT_SHA:-}" == "discover" ]]; then
  [[ -n "${RIPGREP_ARTIFACT_OUTPUT:-}" ]] || fail "hash discovery requires an explicit RIPGREP_ARTIFACT_OUTPUT"
  [[ "$ARTIFACT_OUTPUT" != "$DEFAULT_ARTIFACT_OUTPUT" ]] || fail "hash discovery cannot overwrite the packaged artifact"
  DISCOVER_ARTIFACT=true
elif [[ -n "${RIPGREP_EXPECT_ARTIFACT_SHA:-}" ]]; then
  EXPECTED_ARTIFACT_SHA="$RIPGREP_EXPECT_ARTIFACT_SHA"
  EXPECTED_ARTIFACT_BYTES="${RIPGREP_EXPECT_ARTIFACT_BYTES:-$EXPECTED_ARTIFACT_BYTES}"
  if [[ "$EXPECTED_ARTIFACT_SHA" != "$(pin artifact sha256)" ]]; then
    [[ -n "${RIPGREP_ARTIFACT_OUTPUT:-}" ]] || fail "a noncurrent artifact pin requires an explicit candidate output path"
    [[ "$ARTIFACT_OUTPUT" != "$DEFAULT_ARTIFACT_OUTPUT" ]] || fail "a noncurrent artifact pin cannot replace the packaged artifact"
  fi
fi

CLANG_VERSION="$($CLANG --version)"
case "$CLANG_VERSION" in
  *"clang version $CLANG_RELEASE"*"$LLVM_COMMIT"*) ;;
  *) fail "WASI_SDK_ROOT does not match pinned clang $CLANG_RELEASE / LLVM $LLVM_COMMIT" ;;
esac

RIPGREP_ARCHIVE="$INPUTS/ripgrep-$RIPGREP_VERSION.crate"
download "https://static.crates.io/crates/ripgrep/ripgrep-$RIPGREP_VERSION.crate" "$RIPGREP_ARCHIVE" "$RIPGREP_ARCHIVE_SHA"
tar -xzf "$RIPGREP_ARCHIVE" -C "$INPUTS"
RIPGREP_SOURCE="$INPUTS/ripgrep-$RIPGREP_VERSION"

WASI_LIBC_SOURCE="$INPUTS/wasi-libc"
git clone --quiet --filter=blob:none --no-checkout https://github.com/WebAssembly/wasi-libc.git "$WASI_LIBC_SOURCE"
git -C "$WASI_LIBC_SOURCE" checkout --quiet --detach "$WASI_LIBC_COMMIT"
[[ "$(git -C "$WASI_LIBC_SOURCE" rev-parse HEAD)" == "$WASI_LIBC_COMMIT" ]] || fail "wasi-libc source revision changed"

apply_agentos_patches() {
  local records="$1" patch_target="$2" relative expected patch_file
  while IFS="$(printf '\t')" read -r relative expected; do
    [[ -n "$relative" ]] || continue
    patch_file="$PATCHES/$(basename "$relative")"
    download "https://raw.githubusercontent.com/rivet-dev/agentos/$AGENTOS_COMMIT/$relative" "$patch_file" "$expected"
    patch --batch --forward -d "$patch_target" -p1 < "$patch_file"
  done < <(patch_records "$records")
}

apply_agentos_patches wasiLibc.appliedAgentOsPatches "$WASI_LIBC_SOURCE"
apply_agentos_patches source.appliedAgentOsPatches "$RIPGREP_SOURCE"
cp "$SCRIPT_DIR/Cargo.lock" "$RIPGREP_SOURCE/Cargo.lock"
assert_sha256 "$RIPGREP_SOURCE/Cargo.lock" "$CARGO_LOCK_SHA"

export RUSTUP_HOME CARGO_HOME="$CRATE_CACHE"
RUSTUP_BIN="$(command -v rustup)"
"$RUSTUP_BIN" toolchain install "$RUST_TOOLCHAIN" --profile minimal --target wasm32-wasip1 --no-self-update
RUSTC="$("$RUSTUP_BIN" which --toolchain "$RUST_TOOLCHAIN" rustc)"
CARGO="$("$RUSTUP_BIN" which --toolchain "$RUST_TOOLCHAIN" cargo)"
RUSTC_VERSION="$($RUSTC --version)"
RUSTC_VERBOSE="$($RUSTC --version --verbose)"
CARGO_VERSION="$($CARGO --version)"
case "$RUSTC_VERSION" in
  "rustc $RUSTC_RELEASE"*) ;;
  *) fail "installed Rust toolchain differs from provenance" ;;
esac
case "$RUSTC_VERBOSE" in
  *"commit-hash: $RUSTC_COMMIT"*) ;;
  *) fail "installed rustc commit differs from provenance" ;;
esac
case "$CARGO_VERSION" in
  "cargo $CARGO_RELEASE"*) ;;
  *) fail "installed Cargo differs from provenance: $CARGO_VERSION" ;;
esac

RUST_SYSROOT="$($RUSTC --print sysroot)"
while IFS="$(printf '\t')" read -r relative expected; do
  [[ -n "$relative" ]] || continue
  assert_sha256 "$RUST_SYSROOT/$relative" "$expected"
done < <(artifact_records toolchain.rustlibArchives)

# The pinned cwd patches add symbols absent from wasi-libc's upstream expected
# symbol list, so build the required inputs without the stale check-symbols gate.
if ! make -C "$WASI_LIBC_SOURCE" \
  "$WASI_LIBC_OBJ/copy-startup-files.stamp" \
  libc \
  "$SYSROOT/lib/wasm32-wasi/libm.a" \
  "$SYSROOT/lib/wasm32-wasi/librt.a" \
  "$SYSROOT/lib/wasm32-wasi/libpthread.a" \
  "$SYSROOT/lib/wasm32-wasi/libcrypt.a" \
  "$SYSROOT/lib/wasm32-wasi/libutil.a" \
  "$SYSROOT/lib/wasm32-wasi/libxnet.a" \
  "$SYSROOT/lib/wasm32-wasi/libresolv.a" \
  "CC=$CLANG" \
  "AR=$LLVM_AR" \
  "NM=$LLVM_NM" \
  "SYSROOT=$SYSROOT" \
  "OBJDIR=$WASI_LIBC_OBJ" \
  EXTRA_CFLAGS="-O2 -DNDEBUG" \
  THREAD_MODEL=single > "$RUN_ROOT/wasi-libc-build.log" 2>&1; then
  tail -n 60 "$RUN_ROOT/wasi-libc-build.log" >&2
  fail "wasi-libc required target build failed"
fi

while IFS="$(printf '\t')" read -r relative expected; do
  [[ -n "$relative" ]] || continue
  assert_sha256 "$SYSROOT/${relative#sysroot/}" "$expected"
done < <(artifact_records wasiLibc.compiledArchives)

LIBC_SHA="$(sha256 "$SYSROOT/lib/wasm32-wasi/libc.a")"
export RUSTC
export CARGO_TARGET_DIR="$TARGET_DIR"
export CC_wasm32_wasip1="$CLANG"
export AR_wasm32_wasip1="$LLVM_AR"
export CFLAGS_wasm32_wasip1="--sysroot=$SYSROOT"
export RUSTFLAGS="-C link-self-contained=no -C link-arg=$SYSROOT/lib/wasm32-wasi/crt1-command.o -C link-arg=$SYSROOT/lib/wasm32-wasi/libc.a -C link-arg=$SYSROOT/lib/wasm32-wasi/libwasi-emulated-pthread.a -C link-arg=-L$SYSROOT/lib/wasm32-wasi -C metadata=agentos-libc-${LIBC_SHA:0:16} --cfg tokio_unstable --remap-path-prefix=$RUN_ROOT=/signalbox/ripgrep-build --remap-path-prefix=$WASI_SDK_ROOT=/signalbox/wasi-sdk"
export SOURCE_DATE_EPOCH=0
unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE || true
export GIT_CEILING_DIRECTORIES="$RUN_ROOT"
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL="$RUN_ROOT/gitconfig"
: > "$GIT_CONFIG_GLOBAL"

if git -C "$RIPGREP_SOURCE" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  fail "ripgrep source unexpectedly resolves to a Git worktree"
fi

if ! "$CARGO" build \
  --manifest-path "$RIPGREP_SOURCE/Cargo.toml" \
  --target-dir "$TARGET_DIR" \
  --target wasm32-wasip1 \
  --release \
  --no-default-features \
  --bin rg \
  --locked \
  --jobs 2 > "$RUN_ROOT/ripgrep-build.log" 2>&1; then
  tail -n 60 "$RUN_ROOT/ripgrep-build.log" >&2
  fail "ripgrep cargo build failed"
fi

BUILT_ARTIFACT="$TARGET_DIR/wasm32-wasip1/release/rg.wasm"
BUILT_BYTES="$(wc -c < "$BUILT_ARTIFACT" | tr -d '[:space:]')"
BUILT_SHA="$(sha256 "$BUILT_ARTIFACT")"
if [[ "$DISCOVER_ARTIFACT" != true ]]; then
  [[ "$BUILT_SHA" == "$EXPECTED_ARTIFACT_SHA" ]] || fail "built artifact hash changed: expected $EXPECTED_ARTIFACT_SHA, got $BUILT_SHA"
  [[ "$BUILT_BYTES" == "$EXPECTED_ARTIFACT_BYTES" ]] || fail "built artifact byte size changed: expected $EXPECTED_ARTIFACT_BYTES, got $BUILT_BYTES"
fi
cp "$BUILT_ARTIFACT" "$ARTIFACT_OUTPUT"
ARTIFACT_MANIFEST="${RIPGREP_ARTIFACT_MANIFEST:-$ARTIFACT_OUTPUT.manifest.json}"
RECIPE_SHA="$(sha256 "$SCRIPT_DIR/build-rg-stock-std.sh")"
node -e 'const fs = require("node:fs"); const path = require("node:path"); const [manifestPath, version, archiveSha256, cargoLockSha256, wasiLibcCommit, agentOsCommit, rustToolchain, rustcCommit, clang, llvmCommit, artifactPath, artifactBytes, artifactSha256, recipeSha256, mode] = process.argv.slice(1); const manifest = { schemaVersion: 1, program: "ripgrep", version, source: { archiveSha256, cargoLockSha256, wasiLibcCommit, agentOsCommit }, toolchain: { rustToolchain, rustcCommit, clang, llvmCommit }, build: { script: "build-rg-stock-std.sh", scriptSha256: recipeSha256, canonicalBuildRoot: "/signalbox/ripgrep-build", gitRevision: null, sourceDateEpoch: 0 }, artifact: { path: path.basename(artifactPath), bytes: Number(artifactBytes), sha256: artifactSha256 }, verificationMode: mode }; fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);' \
  "$ARTIFACT_MANIFEST" "$RIPGREP_VERSION" "$RIPGREP_ARCHIVE_SHA" "$CARGO_LOCK_SHA" "$WASI_LIBC_COMMIT" "$AGENTOS_COMMIT" "$RUST_TOOLCHAIN" "$RUSTC_COMMIT" "$CLANG_RELEASE" "$LLVM_COMMIT" "$ARTIFACT_OUTPUT" "$BUILT_BYTES" "$BUILT_SHA" "$RECIPE_SHA" "$([[ "$DISCOVER_ARTIFACT" == true ]] && echo hash-discovery || echo pinned)"
echo "ripgrep $RIPGREP_VERSION rebuilt at $ARTIFACT_OUTPUT"
echo "sha256: $BUILT_SHA"
echo "manifest: $ARTIFACT_MANIFEST"
