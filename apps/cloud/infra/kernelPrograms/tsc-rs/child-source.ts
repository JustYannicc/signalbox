export const TSC_CHILD_SOURCE = String.raw`import { WorkerEntrypoint } from "cloudflare:workers";
import module from "./ts_rust.wasm";
import { createChildWasi } from "./src/computer/ChildWasi.js";
import { runKernelTscReactor } from "./src/kernel/KernelTscReactor.js";

export default class TscChild extends WorkerEntrypoint {
  async run(command, host) {
    const wasi = createChildWasi({module,syscalls:host,args:command.argv,env:command.env});
    let memory;
    const exitCode = await runKernelTscReactor(module, {
      filesystem:host,cwd:command.cwd,args:command.argv,
      host:{
        wasiImports:wasi.imports,
        initialize:async instance => {
          memory=instance.exports.memory;
          await wasi.initialize(instance);
        },
        run:async fn => Number(await wasi.run(fn)),
      },
    });
    await host.observe({linearMemoryBytes:memory.buffer.byteLength,command});
    return {exitCode,signal:0,coreDumped:false};
  }
}
`;
