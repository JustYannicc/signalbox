# ugrep WASI rebuild

Use this recipe to rebuild the pinned ugrep module from its upstream source. The recipe checks the source and SDK archives, compiler identity, output hash, and WASI import/export inventory so a future source or toolchain change has a concrete build record.

The build requires arm64 macOS, Bash, GNU Make, Node, curl, patch, tar, and `shasum`. It uses wasi-sdk 34.0 because ugrep's upstream search and matcher paths use C++ exceptions. The build is static, targets `wasm32-wasip1`, and uses at most two make jobs.

From this directory, pass a fresh work root and a new artifact output path:

```sh
SOURCE_CACHE_DIR=/path/to/pinned-archives \
WASI_SDK_ROOT=/path/to/wasi-sdk-34.0-arm64-macos \
WASI_SDK_ARCHIVE=/path/to/pinned-archives/wasi-sdk-34.0-arm64-macos.tar.gz \
./build.sh /tmp/ugrep-build-r1 /tmp/ugrep-build-r1/output/ugrep.wasm
```

`SOURCE_CACHE_DIR` may contain `ugrep-v7.5.0.tar.gz`; the recipe downloads that exact pinned archive if it is absent. `WASI_SDK_ROOT` selects an extracted SDK without copying or unpacking the large toolchain again. Set `WASI_SDK_ARCHIVE` as shown to verify the SDK distribution archive too. Without `WASI_SDK_ROOT`, the recipe uses the SDK archive from `SOURCE_CACHE_DIR` or downloads and verifies it before extraction.

The output path must not exist, and the work root must be new. The recipe writes the module, a `.manifest.json` with the pins and complete WASI import/export inventory, and a `.LICENSE.txt` copied from the upstream source. `provenance.json` holds the expected hashes and build settings.

WASI Preview 1 cannot launch host processes, so `fork`, `execvp`, `kill`, `popen`, `pclose`, and `system(command)` return `ENOSYS`; `system(NULL)` returns `0`. The TUI key-input path is disabled. The matcher, search, and exception paths remain upstream.
