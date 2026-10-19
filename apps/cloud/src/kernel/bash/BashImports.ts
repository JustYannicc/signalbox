// Asyncify process transitions follow Nimbus e9f019ab4e40cb6037aff7e1a0eaf20842578ed3.
// Copyright (c) 2026 Ashish Kumar Singh and Nimbus contributors. See NIMBUS-LICENSE.
import { createBashHostImports } from "./BashHostImports.ts";
import { bashTransitionImports } from "./BashTransitions.ts";
import { createBashEnvironment } from "./BashEnvironment.ts";
import type { BashProcess } from "./BashProcess.ts";

type Suspending = new (handler: (...args: number[]) => Promise<number>) => WebAssembly.ImportValue;

export function bashImports(process: BashProcess): WebAssembly.Imports {
  const { context } = process;
  const memory = () => process.exports.memory;
  const host = createBashHostImports(context, process.credentials, memory, process.preopens);
  const wasm = WebAssembly as unknown as { Suspending: Suspending };
  return {
    wasi_snapshot_preview1: process.lifecycle.wasiImport,
    nimbus_proc: {
      ...host.nimbus_proc,
      ...bashTransitionImports(process, context.identity.pid),
      dup2: new wasm.Suspending(host.nimbus_proc.dup2),
    },
    env: {
      ...createBashEnvironment({
        memory,
        credentials: process.credentials,
        filesystem: context.filesystem,
        pid: () => context.identity.pid,
      }),
      ...host.env,
    },
    nimbus_procenv: { full: () => process.captures.applyLog(memory()) },
  };
}
