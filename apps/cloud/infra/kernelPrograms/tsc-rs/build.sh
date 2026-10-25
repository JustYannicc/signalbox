#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROVENANCE="$SCRIPT_DIR/provenance.json"
SCRATCH="${1:?usage: build.sh <issue-local scratch directory> <output.wasm>}"
OUTPUT="${2:?usage: build.sh <issue-local scratch directory> <output.wasm>}"
mkdir -p "$SCRATCH" "$(dirname -- "$OUTPUT")"
SCRATCH="$(cd -- "$SCRATCH" && pwd -P)"
OUTPUT="$(cd -- "$(dirname -- "$OUTPUT")" && pwd -P)/$(basename -- "$OUTPUT")"
NOTICE_DIR="$OUTPUT.notices"
RUN_ROOT="$SCRATCH/$(date -u +%Y%m%dT%H%M%SZ)-$$"
SOURCE="$RUN_ROOT/source"
ARCHIVE="$RUN_ROOT/ts-rust.tar.gz"
export CARGO_HOME="$SCRATCH/cargo-home"
export RUSTUP_HOME="$SCRATCH/rustup-home"
mkdir -p "$SOURCE" "$CARGO_HOME" "$RUSTUP_HOME"

fail() {
  echo "tsc-rs build: $*" >&2
  exit 1
}

pin() {
  node -e 'const fs=require("node:fs"); let v=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); for(const k of process.argv.slice(2)) v=v[k]; if(v===undefined || (typeof v==="object" && v!==null)) process.exit(2); console.log(v);' "$PROVENANCE" "$@"
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

assert_sha256() {
  local file="$1" expected="$2" actual
  [[ -f "$file" ]] || fail "missing pinned input: $file"
  actual="$(sha256 "$file")"
  [[ "$actual" == "$expected" ]] || fail "SHA-256 mismatch for $file: expected $expected, got $actual"
}

need() { command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"; }
for command in curl node rustup tar; do need "$command"; done

REVISION="$(pin source revision)"
ARCHIVE_URL="$(pin source archive)"
RUST_TOOLCHAIN="$(pin build rustToolchain)"
RUSTC_COMMIT="$(pin build rustcCommit)"
EXPECTED_CARGO="$(pin build cargo)"
EXPECTED_BYTES="$(pin artifact bytes)"
EXPECTED_SHA="$(pin artifact sha256)"

curl --fail --location --silent --show-error --retry 3 "$ARCHIVE_URL" --output "$ARCHIVE"
assert_sha256 "$ARCHIVE" "$(pin source archiveSha256)"
tar -xzf "$ARCHIVE" -C "$SOURCE" --strip-components=1
assert_sha256 "$SOURCE/Cargo.lock" "$(pin source cargoLockSha256)"
assert_sha256 "$SOURCE/LICENSE" "$(pin source licenseSha256)"
assert_sha256 "$SCRIPT_DIR/LICENSE" "$(pin source licenseSha256)"
assert_sha256 "$SOURCE/$(pin source wasmBuildScript path)" "$(pin source wasmBuildScript sha256)"
assert_sha256 "$SOURCE/$(pin source wasmBuildRs path)" "$(pin source wasmBuildRs sha256)"

NOTICE_FILES=(
  LICENSE
  NOTICE.md
  licenses/Go-LICENSE.txt
  licenses/TypeScript-LICENSE.txt
  licenses/TypeScript-NOTICE.txt
  licenses/Unicode-LICENSE.txt
  licenses/vscode-languageserver-node-LICENSE.txt
)
for relative in "${NOTICE_FILES[@]}"; do
  [[ -f "$SOURCE/$relative" && -f "$SCRIPT_DIR/$relative" ]] || fail "missing upstream notice: $relative"
  cmp -s "$SOURCE/$relative" "$SCRIPT_DIR/$relative" || fail "checked-in notice differs from pinned upstream: $relative"
done
mkdir -p "$NOTICE_DIR/licenses"
for relative in "${NOTICE_FILES[@]}"; do
  mkdir -p "$NOTICE_DIR/$(dirname -- "$relative")"
  cp "$SOURCE/$relative" "$NOTICE_DIR/$relative"
done

rustup toolchain install "$RUST_TOOLCHAIN" --profile minimal --target wasm32-wasip1 --no-self-update
rustc_version="$(rustup run "$RUST_TOOLCHAIN" rustc --version --verbose)"
[[ "$rustc_version" == *"commit-hash: $RUSTC_COMMIT"* ]] || fail "installed rustc commit differs from provenance"
cargo_version="$(rustup run "$RUST_TOOLCHAIN" cargo --version)"
[[ "$cargo_version" == "cargo $EXPECTED_CARGO"* ]] || fail "installed Cargo differs from provenance: $cargo_version"
# The official script discovers registry path remaps before it invokes Cargo.
rustup run "$RUST_TOOLCHAIN" cargo fetch --locked --manifest-path "$SOURCE/Cargo.toml"
unset RUSTFLAGS CARGO_ENCODED_RUSTFLAGS WASM_RUSTFLAGS CARGO_TARGET_DIR CARGO_PROFILE_WASM_OPT_LEVEL \
  CARGO_PROFILE_WASM_LTO CARGO_PROFILE_WASM_CODEGEN_UNITS CARGO_PROFILE_WASM_PANIC \
  CARGO_PROFILE_WASM_STRIP || true
(
  cd "$SOURCE"
  RUSTUP_TOOLCHAIN="$RUST_TOOLCHAIN" CARGO_BUILD_JOBS=2 WASM_PROFILE=wasm WASM_OPT=none \
    bash "$(pin source wasmBuildScript path)" "$OUTPUT"
)
assert_sha256 "$SOURCE/Cargo.lock" "$(pin source cargoLockSha256)"

assert_sha256 "$OUTPUT" "$EXPECTED_SHA"
actual_bytes="$(wc -c < "$OUTPUT" | tr -d '[:space:]')"
[[ "$actual_bytes" == "$EXPECTED_BYTES" ]] || fail "artifact size changed: expected $EXPECTED_BYTES, got $actual_bytes"
RECIPE_SHA="$(sha256 "$SCRIPT_DIR/build.sh")"
node --input-type=module - "$PROVENANCE" "$OUTPUT" "$NOTICE_DIR" "$RUN_ROOT/build-manifest.json" "$REVISION" "$RUST_TOOLCHAIN" "$RECIPE_SHA" <<'NODE'
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const [provenancePath, artifactPath, noticeDir, manifestPath, revision, toolchain, recipeSha256] = process.argv.slice(2);
const pins = JSON.parse(fs.readFileSync(provenancePath, "utf8"));
const bytes = fs.readFileSync(artifactPath);
const module = new WebAssembly.Module(bytes);
const imports = WebAssembly.Module.imports(module).map(({ module, name }) => `${module}.${name}`);
const exports = WebAssembly.Module.exports(module).map(({ name }) => name);
if (JSON.stringify(imports) !== JSON.stringify(pins.artifact.imports)) throw new Error("WASM imports changed");
if (JSON.stringify(exports) !== JSON.stringify(pins.artifact.exports)) throw new Error("WASM exports changed");
const noticeFiles = ["LICENSE", "NOTICE.md", "licenses/Go-LICENSE.txt", "licenses/TypeScript-LICENSE.txt", "licenses/TypeScript-NOTICE.txt", "licenses/Unicode-LICENSE.txt", "licenses/vscode-languageserver-node-LICENSE.txt"];
const manifest = {
  source: revision,
  sourceArchiveSha256: pins.source.archiveSha256,
  toolchain,
  rustcCommit: pins.build.rustcCommit,
  cargo: pins.build.cargo,
  flags: { CARGO_BUILD_JOBS: "2", WASM_OPT: "none", profile: "wasm" },
  heavySlotCallerRequired: pins.build.heavySlotCallerRequired,
  resourceLimit: pins.build.resourceLimit,
  recipeSha256,
  artifact: {
    file: "ts_rust.wasm",
    bytes: bytes.byteLength,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  },
  notices: {
    directory: path.basename(noticeDir),
    files: noticeFiles.map(file => ({
      path: file,
      sha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(noticeDir, file))).digest("hex"),
    })),
  },
  imports,
  exports,
};
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
cp "$RUN_ROOT/build-manifest.json" "$OUTPUT.manifest.json"
echo "artifact: $OUTPUT"
echo "manifest: $OUTPUT.manifest.json"
