import { createBunShim } from "../../src/isolate/BunShim.ts";
import type { NodeFsModules } from "../../src/isolate/NodeFs.ts";
import type { NodeProcessEnvironment } from "../../src/isolate/NodeProcess.ts";

export function createProofBun(options: {
  readonly fs: NodeFsModules;
  readonly env: NodeProcessEnvironment;
  readonly assets: Readonly<Record<string, unknown>>;
  readonly isSeeded: () => boolean;
  readonly onMissing: (member: string) => void;
}) {
  const fs = options.fs.fs;
  return createBunShim({
    env: options.env,
    main: "/$bunfs/root/cli",
    version: "1.3.11",
    files: {
      readFile: async (target) => {
        if (
          typeof target === "string" &&
          Object.hasOwn(options.assets, target) &&
          !options.isSeeded()
        ) {
          throw Object.assign(new Error(`Diagnostic asset bytes not seeded: ${target}`), {
            code: "ERR_DIAGNOSTIC_ASSET_UNSEEDED",
          });
        }
        const bytes = fs.readFileSync(target);
        return typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
      },
      writeFile: async (target, bytes) => {
        fs.writeFileSync(target, bytes);
      },
      stat: async (target) =>
        typeof target === "number" ? fs.fstatSync(target) : fs.statSync(target),
      statSync: (target) =>
        typeof target === "number" ? fs.fstatSync(target) : fs.statSync(target),
    },
    onMissing: options.onMissing,
  }).bun;
}
