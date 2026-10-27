#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROVENANCE="$SCRIPT_DIR/provenance.json"
WORK="${1:?usage: build.sh <fresh work root> <artifact output>}"
OUTPUT="${2:?usage: build.sh <fresh work root> <artifact output>}"

fail() {
  echo "ugrep build: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

pin() {
  node -e 'const fs = require("node:fs"); let value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); for (const key of process.argv.slice(2)) value = value[key]; if (value === undefined || (typeof value === "object" && value !== null)) process.exit(2); process.stdout.write(String(value));' "$PROVENANCE" "$@"
}

sha256() {
  shasum -a 256 "$1" | awk '{print $1}'
}

assert_sha256() {
  local file="$1" expected="$2" actual
  [[ -f "$file" ]] || fail "missing pinned input: $file"
  actual="$(sha256 "$file")"
  [[ "$actual" == "$expected" ]] || fail "SHA-256 mismatch for $file: expected $expected, got $actual"
}

fetch() {
  local url="$1" name="$2" target="$3"
  if [[ -n "${SOURCE_CACHE_DIR:-}" && -f "$SOURCE_CACHE_DIR/$name" ]]; then
    cp "$SOURCE_CACHE_DIR/$name" "$target"
  else
    curl --fail --location --silent --show-error --retry 3 "$url" --output "$target"
  fi
}

[[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]] || fail "this recipe is pinned to arm64 macOS"
for command in awk cat cp curl grep head make mkdir node patch shasum tail tar tr uname wc; do need "$command"; done

[[ ! -e "$WORK" ]] || fail "work root must be fresh: $WORK"
[[ ! -e "$OUTPUT" ]] || fail "artifact output already exists: $OUTPUT"
mkdir -p "$WORK/inputs" "$WORK/source" "$WORK/toolchain" "$WORK/logs" "$(dirname -- "$OUTPUT")"
WORK="$(cd -- "$WORK" && pwd -P)"
OUTPUT="$(cd -- "$(dirname -- "$OUTPUT")" && pwd -P)/$(basename -- "$OUTPUT")"

case "$WORK$SCRIPT_DIR${WASI_SDK_ROOT:-}" in
  *[[:space:]]*) fail "work, recipe, and SDK paths cannot contain whitespace because configure expands compiler flags" ;;
esac

SOURCE_DIR="$(pin source directory)"
SOURCE_ARCHIVE_NAME="$(pin source archive)"
SOURCE_ARCHIVE_SHA="$(pin source archiveSha256)"
SOURCE_URL="$(pin source url)"
SDK_DIR="$(pin toolchain sdk directory)"
SDK_ARCHIVE_NAME="$(pin toolchain sdk archive)"
SDK_ARCHIVE_SHA="$(pin toolchain sdk archiveSha256)"
SDK_URL="$(pin toolchain sdk url)"
SDK_CLANG_VERSION="$(pin toolchain compiler clang)"
SDK_LLVM_COMMIT="$(pin toolchain compiler llvmCommit)"
TARGET="$(pin toolchain target)"
EXPECTED_BYTES="$(pin artifact bytes)"
EXPECTED_SHA="$(pin artifact sha256)"
printf 'Building ugrep %s with wasi-sdk %s for %s\n' "$(pin source version)" "$(pin toolchain sdk version)" "$TARGET" > "$WORK/logs/invocation.log"

SOURCE_ARCHIVE="$WORK/inputs/$SOURCE_ARCHIVE_NAME"
fetch "$SOURCE_URL" "$SOURCE_ARCHIVE_NAME" "$SOURCE_ARCHIVE"
assert_sha256 "$SOURCE_ARCHIVE" "$SOURCE_ARCHIVE_SHA"
tar -xzf "$SOURCE_ARCHIVE" -C "$WORK/source"
SOURCE="$WORK/source/$SOURCE_DIR"
[[ -f "$SOURCE/configure" && -f "$SOURCE/LICENSE.txt" ]] || fail "source archive did not contain the pinned ugrep tree"

SDK_ARCHIVE_PATH="${WASI_SDK_ARCHIVE:-}"
if [[ -z "$SDK_ARCHIVE_PATH" && -n "${SOURCE_CACHE_DIR:-}" && -f "$SOURCE_CACHE_DIR/$SDK_ARCHIVE_NAME" ]]; then
  SDK_ARCHIVE_PATH="$SOURCE_CACHE_DIR/$SDK_ARCHIVE_NAME"
fi
SDK_ARCHIVE_VERIFIED=false
if [[ -n "${WASI_SDK_ROOT:-}" ]]; then
  [[ -d "$WASI_SDK_ROOT" ]] || fail "WASI_SDK_ROOT is not a directory: $WASI_SDK_ROOT"
  SDK="$(cd -- "$WASI_SDK_ROOT" && pwd -P)"
  if [[ -n "$SDK_ARCHIVE_PATH" ]]; then
    assert_sha256 "$SDK_ARCHIVE_PATH" "$SDK_ARCHIVE_SHA"
    SDK_ARCHIVE_VERIFIED=true
  fi
else
  if [[ -z "$SDK_ARCHIVE_PATH" ]]; then
    SDK_ARCHIVE_PATH="$WORK/inputs/$SDK_ARCHIVE_NAME"
    curl --fail --location --silent --show-error --retry 3 "$SDK_URL" --output "$SDK_ARCHIVE_PATH"
  fi
  assert_sha256 "$SDK_ARCHIVE_PATH" "$SDK_ARCHIVE_SHA"
  SDK_ARCHIVE_VERIFIED=true
  tar -xzf "$SDK_ARCHIVE_PATH" -C "$WORK/toolchain"
  SDK="$WORK/toolchain/$SDK_DIR"
fi

for tool in "$SDK/bin/clang" "$SDK/bin/clang++" "$SDK/bin/llvm-ar" "$SDK/bin/llvm-ranlib"; do
  [[ -x "$tool" ]] || fail "missing SDK tool: $tool"
done
"$SDK/bin/clang" --version > "$WORK/logs/clang-version.log" 2>&1
"$SDK/bin/clang++" --version > "$WORK/logs/clangxx-version.log" 2>&1
CLANG_FULL="$(cat "$WORK/logs/clang-version.log")"
CLANG_LINE="$(head -n 1 "$WORK/logs/clang-version.log")"
case "$CLANG_LINE" in
  "clang version $SDK_CLANG_VERSION"*) ;;
  *) fail "WASI_SDK_ROOT has the wrong clang version: $CLANG_LINE" ;;
esac
case "$CLANG_FULL" in
  *"$SDK_LLVM_COMMIT"*) ;;
  *) fail "WASI_SDK_ROOT has the wrong LLVM commit" ;;
esac
ACTUAL_TARGET="$("$SDK/bin/clang" --target="$TARGET" -dumpmachine)"
[[ "$ACTUAL_TARGET" == "wasm32-unknown-wasip1" ]] || fail "SDK target mismatch: $ACTUAL_TARGET"
make --version > "$WORK/logs/make-version.log" 2>&1
grep -q 'GNU Make' "$WORK/logs/make-version.log" || fail "GNU make is required"

PATCH_FILE="$SCRIPT_DIR/patches/0001-wasi-disable-vkey-tui.patch"
assert_sha256 "$SCRIPT_DIR/build.sh" "$(pin build scriptSha256)"
assert_sha256 "$PATCH_FILE" "$(pin patch sha256)"
assert_sha256 "$SCRIPT_DIR/compat/wasi-process-unavailable.h" "$(pin compatibility headerSha256)"
assert_sha256 "$SCRIPT_DIR/compat/wasi-process-unavailable.c" "$(pin compatibility sourceSha256)"
patch -d "$SOURCE" -p1 < "$PATCH_FILE" > "$WORK/logs/source-patch.log" 2>&1

export SOURCE_DATE_EPOCH="$(pin build sourceDateEpoch)"
export TZ=UTC LC_ALL=C
export CC="$SDK/bin/clang --target=$TARGET"
export CXX="$SDK/bin/clang++ --target=$TARGET"
export AR="$SDK/bin/llvm-ar" RANLIB="$SDK/bin/llvm-ranlib"
export CPPFLAGS="-D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_GETPID -include $SCRIPT_DIR/compat/wasi-process-unavailable.h"
export CFLAGS='-O2 -fvisibility=hidden -DDEFAULT_MAX_JOBS=1'
export CXXFLAGS='-O2 -fvisibility=hidden -DDEFAULT_MAX_JOBS=1 -fwasm-exceptions -mllvm -wasm-use-legacy-eh=false'
export PTHREAD_CFLAGS='-D_WASI_EMULATED_SIGNAL'
export PTHREAD_LIBS='-lwasi-emulated-signal -lwasi-emulated-getpid'
export LDFLAGS='-fwasm-exceptions -lunwind -Wl,--strip-debug'
unset MAKEFLAGS MFLAGS || true

CONFIGURE_ARGS=(
  --build=aarch64-apple-darwin
  --host=wasm32-wasip1
  --disable-sse2
  --disable-avx2
  --disable-neon
  --disable-mmap
  --disable-7zip
  --disable-auto-color
  --disable-pager
  --without-pcre2
  --without-boost-regex
  --without-zlib
  --without-bzlib
  --without-lzma
  --without-lz4
  --without-zstd
  --without-brotli
  --without-bzip3
  --with-bash-completion-dir=no
  --with-fish-completion-dir=no
  --with-zsh-completion-dir=no
)
if ! (cd "$SOURCE" && ./configure "${CONFIGURE_ARGS[@]}") > "$WORK/logs/configure.log" 2>&1; then
  tail -n 60 "$WORK/logs/configure.log" >&2 || true
  fail "configure failed; log: $WORK/logs/configure.log"
fi
if ! "$SDK/bin/clang" --target="$TARGET" $CFLAGS $CPPFLAGS -c "$SCRIPT_DIR/compat/wasi-process-unavailable.c" -o "$WORK/wasi-process-unavailable.o" > "$WORK/logs/compat-compile.log" 2>&1; then
  tail -n 60 "$WORK/logs/compat-compile.log" >&2 || true
  fail "compatibility source compile failed; log: $WORK/logs/compat-compile.log"
fi
if ! make -j2 -C "$SOURCE/lib" > "$WORK/logs/lib-compile.log" 2>&1; then
  tail -n 60 "$WORK/logs/lib-compile.log" >&2 || true
  fail "ugrep library compile failed; log: $WORK/logs/lib-compile.log"
fi
if ! make -j2 -C "$SOURCE/src" ugrep LDFLAGS="$LDFLAGS $WORK/wasi-process-unavailable.o" > "$WORK/logs/ugrep-compile.log" 2>&1; then
  tail -n 60 "$WORK/logs/ugrep-compile.log" >&2 || true
  fail "ugrep program compile failed; log: $WORK/logs/ugrep-compile.log"
fi

BUILT_ARTIFACT="$SOURCE/src/ugrep"
BUILT_BYTES="$(wc -c < "$BUILT_ARTIFACT" | tr -d '[:space:]')"
BUILT_SHA="$(sha256 "$BUILT_ARTIFACT")"
[[ "$BUILT_BYTES" == "$EXPECTED_BYTES" ]] || fail "artifact byte size changed: expected $EXPECTED_BYTES, got $BUILT_BYTES"
[[ "$BUILT_SHA" == "$EXPECTED_SHA" ]] || fail "artifact SHA-256 changed: expected $EXPECTED_SHA, got $BUILT_SHA"

node - "$PROVENANCE" "$SCRIPT_DIR" "$BUILT_ARTIFACT" "$OUTPUT" "$SOURCE/LICENSE.txt" "$SDK_ARCHIVE_VERIFIED" "$CLANG_LINE" "$SDK_LLVM_COMMIT" <<'NODE'
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const [provenancePath, scriptDir, builtPath, outputPath, licensePath, sdkArchiveVerified, clang, llvmCommit] = process.argv.slice(2);
const pins = JSON.parse(fs.readFileSync(provenancePath, "utf8"));
const bytes = fs.readFileSync(builtPath);
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const artifactSha = digest(bytes);
const imports = WebAssembly.Module.imports(new WebAssembly.Module(bytes));
const exports = WebAssembly.Module.exports(new WebAssembly.Module(bytes));
if (bytes.length !== pins.artifact.bytes || artifactSha !== pins.artifact.sha256) {
  throw new Error(`artifact pin mismatch: ${bytes.length} bytes, ${artifactSha}`);
}
if (JSON.stringify(imports) !== JSON.stringify(pins.artifact.imports)) {
  throw new Error("WASI import inventory differs from provenance.json");
}
if (JSON.stringify(exports) !== JSON.stringify(pins.artifact.exports)) {
  throw new Error("WASI export inventory differs from provenance.json");
}
const scriptHash = digest(fs.readFileSync(path.join(scriptDir, "build.sh")));
if (scriptHash !== pins.build.scriptSha256) throw new Error("build script SHA-256 differs from provenance.json");
const patchHash = digest(fs.readFileSync(path.join(scriptDir, pins.patch.file)));
if (patchHash !== pins.patch.sha256) throw new Error("source patch SHA-256 differs from provenance.json");
const headerHash = digest(fs.readFileSync(path.join(scriptDir, pins.compatibility.header)));
const compatHash = digest(fs.readFileSync(path.join(scriptDir, pins.compatibility.source)));
if (headerHash !== pins.compatibility.headerSha256 || compatHash !== pins.compatibility.sourceSha256) {
  throw new Error("compatibility source hashes differ from provenance.json");
}
const licenseBytes = fs.readFileSync(licensePath);
const licenseSha = digest(licenseBytes);
if (licenseSha !== pins.source.license.sha256) throw new Error("upstream license SHA-256 differs from provenance.json");
const licenseFile = `${path.basename(outputPath)}.LICENSE.txt`;
fs.writeFileSync(outputPath, bytes);
fs.writeFileSync(`${outputPath}.manifest.json`, JSON.stringify({
  schemaVersion: 1,
  program: "ugrep",
  source: {
    repository: pins.source.repository,
    version: pins.source.version,
    commit: pins.source.commit,
    archive: pins.source.archive,
    archiveSha256: pins.source.archiveSha256,
    license: { file: licenseFile, sha256: licenseSha },
  },
  toolchain: {
    sdk: pins.toolchain.sdk.version,
    sdkArchive: pins.toolchain.sdk.archive,
    sdkArchiveSha256: pins.toolchain.sdk.archiveSha256,
    sdkArchiveVerifiedThisRun: sdkArchiveVerified === "true",
    clang,
    llvmCommit,
    target: pins.toolchain.target,
    host: pins.toolchain.host,
  },
  build: {
    recipe: pins.build.script,
    recipeSha256: scriptHash,
    sourceDateEpoch: pins.build.sourceDateEpoch,
    jobs: pins.build.jobs,
    cxxFlags: pins.build.cxxFlags,
    linkFlags: pins.build.linkFlags,
    configure: pins.build.configure,
  },
  compatibility: {
    header: pins.compatibility.header,
    headerSha256: headerHash,
    source: pins.compatibility.source,
    sourceSha256: compatHash,
    unavailableProcessCalls: pins.compatibility.unavailableProcessCalls,
  },
  patches: [{ file: pins.patch.file, sha256: patchHash }],
  artifact: {
    file: path.basename(outputPath),
    bytes: bytes.length,
    sha256: artifactSha,
    imports,
    exports,
  },
}, null, 2) + "\n");
fs.writeFileSync(`${outputPath}.LICENSE.txt`, licenseBytes);
console.log(JSON.stringify({ bytes: bytes.length, sha256: artifactSha, imports: imports.length, exports: exports.length }));
NODE
