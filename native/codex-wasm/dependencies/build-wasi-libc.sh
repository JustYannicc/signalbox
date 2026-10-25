#!/usr/bin/env bash
# Build agentOS's patched wasi-libc sysroot (host_process / host_net / host_user imports)
# for linking the Codex wasm. Adapted from agentOS toolchain/scripts/patch-wasi-libc.sh
# at a6c668c^, minus the libc++/libunwind rebuild (Codex links no C++ runtime) and
# portable to macOS bash 3.2 / GNU make 3.81.
#
# Output: $CL/sysroot/lib/wasm32-wasi/{libc.a,crt1-command.o,libwasi-emulated-*.a,...}
set -euo pipefail
: "${CL:?}" "${AOS_TC:?}" "${WASI_SDK_DIR:?}"

SRC="$CL/wasi-libc"
SYSROOT_DIR="$CL/sysroot"
PATCHES_DIR="$AOS_TC/std-patches/wasi-libc"
OVERRIDES_DIR="$AOS_TC/std-patches/wasi-libc-overrides"
OVERRIDE_INCLUDE_DIR="$AOS_TC/c/include"
WASI_CC="$WASI_SDK_DIR/bin/clang"
WASI_AR="$WASI_SDK_DIR/bin/llvm-ar"
WASI_NM="$WASI_SDK_DIR/bin/llvm-nm"

[ -f "$SRC/Makefile" ] || { echo "ERROR: missing staged wasi-libc" >&2; exit 1; }
# Otherwise git apply discovers the parent repository and skips ignored cache files.
git -C "$SRC" init --quiet
for patch in "$PATCHES_DIR"/*.patch; do
	printf 'applying %s ... ' "$(basename "$patch")"
	git -C "$SRC" apply "$patch"
	echo ok
done
grep -Fq 'pid_t wait(int *status) {' "$SRC/libc-bottom-half/sources/host_spawn_wait.c" || {
	echo "ERROR: materialized host_spawn_wait.c is truncated" >&2; exit 1; }

rm -rf "$SYSROOT_DIR"
make -s -C "$SRC" CC="$WASI_CC" AR="$WASI_AR" NM="$WASI_NM" SYSROOT="$SYSROOT_DIR" libc -j2

SYSROOT_LIB="$SYSROOT_DIR/lib/wasm32-wasi"
VANILLA_LIB="$WASI_SDK_DIR/share/wasi-sysroot/lib/wasm32-wasi"
cp "$VANILLA_LIB"/crt*.o "$SYSROOT_LIB/"
for lib in m rt pthread crypt util xnet resolv; do "$WASI_AR" crs "$SYSROOT_LIB/lib${lib}.a"; done

# host_socket.o / host_sigaction.o replace these upstream objects.
"$WASI_AR" d "$SYSROOT_LIB/libc.a" accept-wasip1.o send.o recv.o select.o poll.o getsockopt.o ioctl.o 2>/dev/null || true
"$WASI_AR" d "$SYSROOT_LIB/libc.a" sigaction.o signal.o 2>/dev/null || true

for sub in include lib; do
	[ -e "$SYSROOT_DIR/$sub/wasm32-wasip1" ] || ln -s wasm32-wasi "$SYSROOT_DIR/$sub/wasm32-wasip1"
done

OVERRIDE_CFLAGS=(--target=wasm32-wasip1 "--sysroot=$SYSROOT_DIR" -O2 -D_GNU_SOURCE "-I$OVERRIDE_INCLUDE_DIR")
OVERRIDE_INTERNAL_CFLAGS=("-I$SRC/libc-top-half/musl/src/internal" "-I$SRC/libc-top-half/musl/arch/wasm32")
for sym in fcntl close strfmon open_wmemstream swprintf inet_ntop __pthread_mutex_lock pthread_attr_setguardsize pthread_mutexattr_setrobust __pthread_key_create fmtmsg; do
	line=$("$WASI_NM" --print-file-name "$SYSROOT_LIB/libc.a" 2>/dev/null | { grep " [TW] ${sym}\$" || true; } | head -1)
	if [ -n "$line" ]; then
		obj=$(echo "$line" | sed 's/.*:\([^:]*\.o\):.*/\1/')
		"$WASI_AR" d "$SYSROOT_LIB/libc.a" "$obj" 2>/dev/null || true
	fi
done
for src in "$OVERRIDES_DIR"/*.c; do
	name="$(basename "${src%.c}")"
	if [ "$name" = pthread_key ]; then
		"$WASI_CC" "${OVERRIDE_CFLAGS[@]}" "${OVERRIDE_INTERNAL_CFLAGS[@]}" -c "$src" -o "$SYSROOT_LIB/override_${name}.o"
	else
		"$WASI_CC" "${OVERRIDE_CFLAGS[@]}" -c "$src" -o "$SYSROOT_LIB/override_${name}.o"
	fi
	"$WASI_AR" r "$SYSROOT_LIB/libc.a" "$SYSROOT_LIB/override_${name}.o"
	rm -f "$SYSROOT_LIB/override_${name}.o"
done
echo "patched sysroot: $SYSROOT_LIB/libc.a ($(wc -c < "$SYSROOT_LIB/libc.a") bytes)"
