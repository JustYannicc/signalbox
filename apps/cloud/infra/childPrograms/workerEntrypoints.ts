export function bashMain(entrypoint: string): string {
  return [
    'import { WorkerEntrypoint } from "cloudflare:workers";',
    'import module from "./program.wasm";',
    'import { createWorkerChildBash } from "./src/computer/ChildBashWorker.js";',
    `export class ${entrypoint} extends WorkerEntrypoint {`,
    "  async run(command, owner) {",
    "    let pid, credentials, residentByteLimit;",
    "    const metadata = await owner.metadata();",
    "    try { ({ pid, credentials, residentByteLimit } = metadata); } finally { metadata[Symbol.dispose]?.(); }",
    "    const snapshot = await owner.forkSnapshot();",
    "    let bash;",
    "    try { bash = createWorkerChildBash({ module, credentials, pid, port: owner, args: command.argv, env: command.env, snapshot, residentWasmBudgetBytes: residentByteLimit }); } catch (error) { snapshot?.[Symbol.dispose]?.(); throw error; }",
    "    try { return await bash.run(); } finally { await bash.drain(); }",
    "  }",
    "}",
    "",
  ].join("\n");
}

export function busyboxMain(entrypoint: string): string {
  return [
    'import { WorkerEntrypoint } from "cloudflare:workers";',
    'import module from "./program.wasm";',
    'import { createChildBusybox } from "./src/computer/ChildBusybox.js";',
    `export class ${entrypoint} extends WorkerEntrypoint {`,
    "  async run(command, owner) {",
    "    return await createChildBusybox({ module, port: owner, args: command.argv, env: command.env }).run();",
    "  }",
    "}",
    "",
  ].join("\n");
}

export function ripgrepMain(entrypoint: string): string {
  return [
    'import { WorkerEntrypoint } from "cloudflare:workers";',
    'import module from "./program.wasm";',
    'import { createChildWasi } from "./src/computer/ChildWasi.js";',
    `export class ${entrypoint} extends WorkerEntrypoint {`,
    "  async run(command, owner) {",
    "    const wasi = createChildWasi({ module, syscalls: owner, args: command.argv, env: { ...command.env, PWD: command.cwd } });",
    "    const instance = new WebAssembly.Instance(module, wasi.imports);",
    "    wasi.bind(instance);",
    "    return await wasi.startProcess(instance);",
    "  }",
    "}",
    "",
  ].join("\n");
}

export function measuredProgramMain(kind: "Coreutils" | "Git") {
  return (entrypoint: string) =>
    [
      'import { WorkerEntrypoint } from "cloudflare:workers";',
      'import module from "./program.wasm";',
      `import { createChild${kind} } from "./src/computer/Child${kind}.js";`,
      `export class ${entrypoint} extends WorkerEntrypoint {`,
      "  async run(command, owner) {",
      `    return await createChild${kind}({ module, port: owner, args: command.argv, env: command.env }).run();`,
      "  }",
      "}",
      "",
    ].join("\n");
}
