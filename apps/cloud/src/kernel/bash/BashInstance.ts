import { ARENA_SIZE, BashCaptureStore } from "./BashCaptureStore.ts";
import type { BashExports } from "./BashProcess.ts";

export function createBashInstance(module: WebAssembly.Module, imports: WebAssembly.Imports) {
  const instance = new WebAssembly.Instance(module, imports);
  const ex = checkedExports(instance);
  const base = ex.memory.buffer.byteLength;
  ex.memory.grow(ARENA_SIZE / 65_536);
  const captures = new BashCaptureStore(
    {
      low: Number(ex.__data_end.value),
      high: Number(ex.__heap_base.value),
      log: ex.nimbus_procenv_log(),
    },
    base,
    ARENA_SIZE,
  );
  return { instance, exports: ex, captures };
}

function checkedExports(instance: WebAssembly.Instance): BashExports {
  const ex = instance.exports;
  for (const name of [
    "_start",
    "nimbus_procenv_log",
    "asyncify_start_unwind",
    "asyncify_stop_unwind",
    "asyncify_start_rewind",
    "asyncify_stop_rewind",
  ]) {
    if (typeof ex[name] !== "function") throw new Error(`GNU Bash module lacks ${name}`);
  }
  if (!(ex.memory instanceof WebAssembly.Memory)) throw new Error("GNU Bash module lacks memory");
  for (const name of ["__stack_pointer", "__data_end", "__heap_base"]) {
    if (!(ex[name] instanceof WebAssembly.Global)) throw new Error(`GNU Bash module lacks ${name}`);
  }
  const checked = ex as unknown as BashExports;
  const sp = Number(checked.__stack_pointer.value);
  if (!(Number(checked.__data_end.value) < sp && sp <= Number(checked.__heap_base.value)))
    throw new Error("GNU Bash stack bounds are invalid");
  checked.__stack_pointer.value = sp;
  return checked;
}
