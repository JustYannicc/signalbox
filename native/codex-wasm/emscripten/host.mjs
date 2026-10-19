// Numeric handles, pointers and errno belong to this module-local adapter.
// The shared kernel ABI and wake registry are supplied by its request owner.
const ERRNO = Object.freeze({
  PERMISSION_DENIED: 2,
  ALREADY_WAITING: 7,
  INVALID_HANDLE: 8,
  CANCELLED: 11,
  ALREADY_EXISTS: 20,
  INVALID_ARGUMENT: 28,
  IO_ERROR: 29,
  RESOURCE_LIMIT: 33,
  NOT_FOUND: 44,
  EXPIRED: 73,
  UNSUPPORTED: 138,
  ABI_MISMATCH: 138,
});
const errorNumber = (error) => ERRNO[error?.code] ?? ERRNO.IO_ERROR;
const failure = (code, message) => ({ status: "error", error: { code, message } });
const ok = (value) => ({ status: "ok", value });
const wouldBlock = { status: "would_block" };

/**
 * Shared dependencies: request-owned wakes and attemptKernelOperation from KernelAbi.
 * subscribeFd({fd, events}, notify) returns an unsubscribe function for each fd.
 * tryPoll(requests) synchronously returns KernelResult<number[]>: one revents per
 * request, or would_block without a token. It must never return a Promise.
 * capabilities is a local feature mask, not a list of KernelCapability names.
 * Default 1 provides only JSPI parking/timers. No process/network support is inferred.
 */
export function createEmscriptenHost({
  wakes,
  attemptKernelOperation,
  subscribeFd,
  tryPoll,
  capabilities = 1,
  signal,
  clock = { now: () => performance.now(), setTimeout, clearTimeout },
}) {
  if (
    !wakes ||
    typeof wakes.wait !== "function" ||
    typeof wakes.release !== "function" ||
    typeof attemptKernelOperation !== "function"
  ) {
    throw new TypeError(
      "Emscripten host needs the shared kernel wake registry and attemptKernelOperation",
    );
  }
  if (!Number.isInteger(capabilities) || capabilities < 0 || (capabilities & ~31) !== 0) {
    throw new TypeError("invalid Emscripten adapter capability mask");
  }
  const reactors = new Map();
  let nextHandle = 1;
  let memory;
  let disposed = false;
  const view = () => new DataView(memory.buffer);
  const validRange = (pointer, length, alignment) =>
    memory &&
    Number.isInteger(pointer) &&
    pointer >= 0 &&
    pointer % alignment === 0 &&
    length >= 0 &&
    pointer <= memory.buffer.byteLength &&
    length <= memory.buffer.byteLength - pointer;
  const put = (pointer, value) => view().setUint32(pointer, value, true);

  function close(state) {
    state.closed = true;
    state.abort.abort();
    for (const token of state.tokens) wakes.release(token);
    state.tokens.clear();
    state.listeners.clear();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener("abort", dispose);
    for (const state of reactors.values()) close(state);
    reactors.clear();
  }
  signal?.addEventListener("abort", dispose, { once: true });
  if (signal?.aborted) dispose();

  const imports = {
    runtime_require(required) {
      if (disposed) return ERRNO.CANCELLED;
      return (required & ~31) !== 0 || (required & capabilities) !== required
        ? ERRNO.UNSUPPORTED
        : 0;
    },
    reactor_new(out) {
      if (disposed) return ERRNO.CANCELLED;
      if (!validRange(out >>> 0, 4, 4)) return ERRNO.INVALID_ARGUMENT;
      if (nextHandle > 0xffff_ffff) return ERRNO.RESOURCE_LIMIT;
      const handle = nextHandle++;
      reactors.set(handle, {
        woken: false,
        closed: false,
        polling: false,
        listeners: new Set(),
        tokens: new Set(),
        abort: new AbortController(),
      });
      put(out >>> 0, handle);
      return 0;
    },
    reactor_drop(handle) {
      const state = reactors.get(handle >>> 0);
      if (!state) return ERRNO.INVALID_HANDLE;
      close(state);
      reactors.delete(handle >>> 0);
      return 0;
    },
    reactor_wake(handle) {
      const state = reactors.get(handle >>> 0);
      if (!state || state.closed) return ERRNO.INVALID_HANDLE;
      state.woken = true;
      // Notifications can unsubscribe listeners synchronously. Keep this snapshot.
      for (const notify of Array.from(state.listeners)) notify();
      return 0;
    },
    async reactor_poll(handle, pointer, count, timeoutMs, out) {
      const state = reactors.get(handle >>> 0);
      if (!state || state.closed) return ERRNO.INVALID_HANDLE;
      if (disposed) return ERRNO.CANCELLED;
      if (state.polling) return ERRNO.ALREADY_WAITING;
      pointer >>>= 0;
      count >>>= 0;
      out >>>= 0;
      if (
        !Number.isInteger(timeoutMs) ||
        timeoutMs < -1 ||
        timeoutMs > 0x7fff_ffff ||
        !validRange(pointer, count * 8, 4) ||
        !validRange(out, 4, 4)
      )
        return ERRNO.INVALID_ARGUMENT;
      const requests = [];
      for (let i = 0; i < count; i++) {
        requests.push(
          Object.freeze({
            fd: view().getInt32(pointer + i * 8, true),
            events: view().getInt16(pointer + i * 8 + 4, true),
          }),
        );
        view().setInt16(pointer + i * 8 + 6, 0, true);
      }
      Object.freeze(requests);
      put(out, 0);
      const active = requests.filter((request) => request.fd >= 0);
      if (active.length && (typeof subscribeFd !== "function" || typeof tryPoll !== "function")) {
        return ERRNO.UNSUPPORTED;
      }
      const deadline = timeoutMs === -1 ? Infinity : clock.now() + timeoutMs;
      state.polling = true;
      const empty = () => requests.map(() => 0);
      function attempt() {
        if (disposed || state.closed) return failure("CANCELLED", "Emscripten reactor closed");
        const result = active.length ? tryPoll(requests) : ok(empty());
        if (!result || typeof result.then === "function")
          return failure("IO_ERROR", "tryPoll must return synchronously");
        if (result.status === "error") return result;
        if (result.status === "ok") {
          const flags = result.value;
          if (
            !Array.isArray(flags) ||
            flags.length !== requests.length ||
            flags.some(
              (value, i) =>
                !Number.isInteger(value) ||
                value < 0 ||
                value > 0xffff ||
                (requests[i].fd < 0 && value !== 0),
            )
          ) {
            return failure("IO_ERROR", "invalid host poll events");
          }
          if (flags.some((value) => value !== 0)) {
            state.woken = false;
            return ok(flags);
          }
        } else if (result.status !== "would_block") {
          return failure("IO_ERROR", "invalid tryPoll result");
        }
        if (state.woken) {
          state.woken = false;
          return ok(empty());
        }
        return clock.now() >= deadline ? ok(empty()) : wouldBlock;
      }
      function subscribe(notify) {
        const cleanups = [];
        const cleanup = () => {
          for (const unsubscribe of cleanups.splice(0).toReversed()) {
            try {
              unsubscribe();
            } catch {
              /* A broken backend must not leak other registrations. */
            }
          }
        };
        try {
          state.listeners.add(notify);
          cleanups.push(() => state.listeners.delete(notify));
          for (const request of active) {
            const unsubscribe = subscribeFd(request, notify);
            if (typeof unsubscribe !== "function")
              throw new TypeError("fd subscription needs an unsubscribe function");
            cleanups.push(unsubscribe);
          }
          if (deadline !== Infinity) {
            const timer = clock.setTimeout(notify, Math.max(0, deadline - clock.now()));
            cleanups.push(() => clock.clearTimeout(timer));
          }
          return cleanup;
        } catch (error) {
          cleanup();
          throw error;
        }
      }
      try {
        for (;;) {
          const result = attemptKernelOperation(wakes, subscribe, attempt);
          if (disposed || state.closed) return ERRNO.CANCELLED;
          if (result.status === "error") return errorNumber(result.error);
          if (result.status === "ok") {
            // The guest memory can grow while JSPI is suspended. Never retain a view.
            for (let i = 0; i < count; i++)
              view().setUint16(pointer + i * 8 + 6, result.value[i], true);
            put(out, result.value.filter((flags) => flags !== 0).length);
            return 0;
          }
          const token = result.wakeToken;
          state.tokens.add(token);
          try {
            const completion = await wakes.wait(token, state.abort.signal);
            if (completion.status === "error") return errorNumber(completion.error);
          } finally {
            state.tokens.delete(token);
            wakes.release(token);
          }
          // A one-shot readiness notification only authorizes another I/O attempt.
        }
      } catch {
        return ERRNO.IO_ERROR;
      } finally {
        state.polling = false;
      }
    },
  };
  return {
    imports: { signalbox_emscripten: imports },
    suspendingImports: ["signalbox_emscripten.reactor_poll"],
    attach(instance) {
      const memories = Object.values(instance.exports).filter(
        (value) => value instanceof WebAssembly.Memory,
      );
      if (memories.length !== 1 || !(memories[0].buffer instanceof ArrayBuffer)) {
        throw new TypeError("Emscripten host requires one unshared exported memory");
      }
      if (memory && memory !== memories[0]) throw new Error("Emscripten host is already attached");
      memory = memories[0];
    },
    dispose,
    get activeReactors() {
      return reactors.size;
    },
  };
}
