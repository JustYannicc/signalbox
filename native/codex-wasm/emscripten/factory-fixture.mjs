// Test double for 4.0.10's factory protocol. This is not a generated Codex engine.
export default async function createCodex(options) {
  if (!options.noInitialRun) throw new Error("main must not run during load");
  let instance;
  await new Promise((resolve) => {
    options.instantiateWasm(globalThis.generatedImports ?? {}, (created, module) => {
      if (!(module instanceof WebAssembly.Module)) throw new Error("expected static module");
      instance = created;
      resolve();
    });
  });
  return {
    async callMain(args) {
      const code = await WebAssembly.promising(instance.exports.main)();
      if (args[0] === "--version") {
        options.print?.(
          JSON.stringify({ version: "fixture", abiVersion: 1, transport: "app-server-ndjson" }),
        );
      }
      return code;
    },
  };
}
