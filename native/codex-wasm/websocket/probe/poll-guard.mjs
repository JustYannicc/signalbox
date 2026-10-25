// A diagnostic budget at poll_oneoff, including iterations that never park.
// The tiny Wasm forwarder preserves the public kernel's opaque Suspending import.
import * as NodeAssert from "node:assert/strict";

export function pollGuardBytes() {
  const string = (value) => [value.length, ...new TextEncoder().encode(value)];
  const section = (id, payload) => [id, payload.length, ...payload];
  const body = [0, 0x20, 0, 0x20, 1, 0x20, 2, 0x20, 3, 0x10, 0, 0x0b];
  return Uint8Array.from([
    0,
    97,
    115,
    109,
    1,
    0,
    0,
    0,
    ...section(1, [1, 0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f]),
    ...section(2, [1, ...string("env"), ...string("poll"), 0, 0]),
    ...section(3, [1, 0]),
    ...section(7, [1, ...string("call"), 0, 1]),
    ...section(10, [1, body.length, ...body]),
  ]);
}

export function guardPoll(imports, before = () => {}, budget = 128, module) {
  const forwarder = new WebAssembly.Instance(module ?? new WebAssembly.Module(pollGuardBytes()), {
    env: { poll: imports.wasi_snapshot_preview1.poll_oneoff },
  });
  const call = WebAssembly.promising(forwarder.exports.call);
  let calls = 0;
  imports.wasi_snapshot_preview1.poll_oneoff = new WebAssembly.Suspending((...args) => {
    NodeAssert.ok(++calls <= budget, `poll_oneoff exceeded diagnostic budget ${budget}`);
    before(args);
    return call(...args);
  });
  return () => calls;
}
