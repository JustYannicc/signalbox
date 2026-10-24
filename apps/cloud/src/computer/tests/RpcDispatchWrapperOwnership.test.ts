import { describe, expect, it, vi } from "vite-plus/test";
import { createChildWorkerDispatchCode } from "../ChildWorkerDispatchCode.ts";

const exit = { exitCode: 17, signal: 0, coreDumped: false };

describe("generated dispatch host ownership", () => {
  it.each(["success", "import-error", "guest-error", "stop-error"] as const)(
    "keeps the host alive until guest completion on %s",
    async (mode) => {
      const dispose = vi.fn();
      const events: string[] = [];
      dispose.mockImplementation(() => events.push("disposed"));
      const host = { [Symbol.dispose]: dispose };
      const input = {
        mainModule: "main.js",
        modules: { "main.js": "export default {}" },
        command: { executable: "/bin/tool", argv: [], cwd: "/", env: {} },
      };
      const code = createChildWorkerDispatchCode(input, { cpuMs: 300_000 });
      const source = code.modules[code.mainModule];
      if (typeof source !== "string") throw new Error("Expected generated dispatch JavaScript");
      const load = async () => {
        expect(dispose).not.toHaveBeenCalled();
        if (mode === "import-error") throw new Error(mode);
        return {
          default: class {
            async run() {
              expect(dispose).not.toHaveBeenCalled();
              events.push("run");
              if (mode === "guest-error") throw new Error(mode);
              return exit;
            }
          },
        };
      };
      const Entry = new Function(
        "WorkerEntrypoint",
        "load",
        source
          .replace(/^import .*;$/gm, "")
          .replace("export default class", "return class")
          .replace(/await import\([^\n]+\)/, "await load()"),
      )(Object, load) as new () => {
        run(command: unknown, invocation: unknown): Promise<typeof exit>;
      };
      const invocation = {
        host: async () => host,
        async stopped() {
          events.push("stopped");
          if (mode === "stop-error") throw new Error(mode);
        },
      };
      const result = new Entry().run(input.command, invocation);
      if (mode === "success") expect(await result).toEqual(exit);
      else await expect(result).rejects.toThrow(mode);
      expect(dispose).toHaveBeenCalledOnce();
      expect(events).toEqual(
        mode === "import-error" ? ["disposed", "stopped"] : ["run", "disposed", "stopped"],
      );
    },
  );
});
