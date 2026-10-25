import createCodex from "./engine.mjs";

/**
 * Emscripten 4.0.10 MODULARIZE/EXPORT_ES6 + JSPI factory, with callMain exported.
 * host retains imports/suspendingImports/attach from loader.mjs and may supply
 * arguments (without argv[0]), thisProgram, print and printErr. For version proof
 * use arguments: ["--version"] and collect the lines delivered to print.
 */
export async function loadCodex(precompiledModule, host) {
  if (!(precompiledModule instanceof WebAssembly.Module)) {
    throw new TypeError("loadCodex requires a precompiled WebAssembly.Module");
  }
  if (typeof WebAssembly.Suspending !== "function" || typeof WebAssembly.promising !== "function") {
    throw new Error("Codex Emscripten engine needs JSPI support");
  }
  const suspending = new Set(host.suspendingImports ?? []);
  let instance;
  const runtime = await createCodex({
    noInitialRun: true,
    thisProgram: host.thisProgram ?? "signalbox-codex-engine",
    arguments: [...(host.arguments ?? [])],
    ...(host.print === undefined ? {} : { print: host.print }),
    ...(host.printErr === undefined ? {} : { printErr: host.printErr }),
    // This is the only instantiation path. No fetch/compile/instantiateStreaming.
    instantiateWasm(generatedImports, receiveInstance) {
      const imports = Object.create(null);
      for (const descriptor of WebAssembly.Module.imports(precompiledModule)) {
        const name = `${descriptor.module}.${descriptor.name}`;
        const supplied = host.imports?.[descriptor.module]?.[descriptor.name];
        const value =
          supplied === undefined
            ? generatedImports[descriptor.module]?.[descriptor.name]
            : supplied;
        if (value === undefined) throw new Error(`Missing Codex kernel import: ${name}`);
        if (
          suspending.has(name) &&
          (descriptor.kind !== "function" || typeof supplied !== "function")
        ) {
          throw new Error(`Suspending Codex import needs a host function: ${name}`);
        }
        (imports[descriptor.module] ??= Object.create(null))[descriptor.name] = suspending.has(name)
          ? new WebAssembly.Suspending(supplied)
          : value;
        suspending.delete(name);
      }
      if (suspending.size) {
        throw new Error(`Unknown suspending Codex import: ${[...suspending].join(", ")}`);
      }
      instance = new WebAssembly.Instance(precompiledModule, imports);
      host.attach?.(instance);
      receiveInstance(instance, precompiledModule);
      return instance.exports;
    },
  });
  if (!instance) throw new Error("Emscripten factory did not use instantiateWasm");
  if (typeof runtime.callMain !== "function") {
    throw new Error("Codex Emscripten engine has no callMain runtime export");
  }
  let started = false;
  return {
    instance,
    async run() {
      if (started) throw new Error("A Codex command instance can only run once");
      started = true;
      // 4.0.10 callMain awaits JSPI main and converts Emscripten ExitStatus into
      // a numeric code. Preserve failures instead of claiming a successful run.
      const code = await runtime.callMain([...(host.arguments ?? [])]);
      if (code !== 0) throw new Error(`Codex Emscripten engine exited ${code}`);
    },
  };
}
