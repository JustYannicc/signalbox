/**
 * Instantiate an ahead-of-time compiled module with the session kernel's imports.
 * Both workerd and Durable Objects pass a static `.wasm` module here.
 */
export function loadCodex(module, host) {
  if (!(module instanceof WebAssembly.Module)) {
    throw new TypeError("loadCodex requires a precompiled WebAssembly.Module");
  }
  const suspending = new Set(host.suspendingImports ?? []);
  if (
    suspending.size &&
    (typeof WebAssembly.Suspending !== "function" || typeof WebAssembly.promising !== "function")
  ) {
    throw new Error("Codex kernel imports need JSPI support");
  }
  const imports = {};
  for (const descriptor of WebAssembly.Module.imports(module)) {
    const name = `${descriptor.module}.${descriptor.name}`;
    const value = host.imports[descriptor.module]?.[descriptor.name];
    if (value === undefined) throw new Error(`Missing Codex kernel import: ${name}`);
    if (suspending.has(name) && descriptor.kind !== "function") {
      throw new Error(`Suspending Codex import is not a function: ${name}`);
    }
    (imports[descriptor.module] ??= {})[descriptor.name] = suspending.has(name)
      ? new WebAssembly.Suspending(value)
      : value;
    suspending.delete(name);
  }
  if (suspending.size) {
    throw new Error(`Unknown suspending Codex import: ${[...suspending].join(", ")}`);
  }
  const instance = new WebAssembly.Instance(module, imports);
  if (typeof instance.exports._start !== "function") {
    throw new Error("Codex command module has no _start export");
  }
  host.attach?.(instance);
  const start =
    typeof WebAssembly.promising === "function"
      ? WebAssembly.promising(instance.exports._start)
      : instance.exports._start;
  let started = false;
  return {
    instance,
    async run() {
      if (started) throw new Error("A Codex command instance can only run once");
      started = true;
      await start();
    },
  };
}
