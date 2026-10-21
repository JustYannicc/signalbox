import { describe, expect, it } from "vite-plus/test";
import { createNodeBridge } from "../../isolate/NodeBridge.ts";
import { createHarnessRuntime } from "./runtime.ts";
import { fixture } from "./tests/fixture.ts";

describe("Node harness terminal detection", () => {
  it.each([false, true])("installs guest tty with supplied native tty = %s", async (supplyTty) => {
    const f = fixture();
    const controller = new AbortController();
    let runtime: ReturnType<typeof createHarnessRuntime> | undefined;
    try {
      runtime = createHarnessRuntime(
        {
          ...f.input,
          nativeModules: supplyTty
            ? {
                tty: {
                  isatty() {
                    throw new Error("Host descriptors must not be inspected");
                  },
                },
              }
            : {},
        },
        { lifetime: controller.signal, stdin: controller.signal, output: controller.signal },
        () => {
          throw new Error("No child processes in this fixture");
        },
        () => {
          throw new Error("No package initialization in this fixture");
        },
      );
      const bridge = createNodeBridge(runtime.modules);
      const tty = bridge.require("tty");
      expect(bridge.require("node:tty")).toBe(tty);
      const isatty = Reflect.get(tty, "isatty");
      for (const fd of [-1, 0, 1, 2, 42, NaN]) expect(isatty(fd)).toBe(false);
      for (const name of ["ReadStream", "WriteStream"]) {
        expect(() => Reflect.construct(Reflect.get(tty, name), [0])).toThrow(
          expect.objectContaining({ code: "ENOTSUP", syscall: `tty.${name}` }),
        );
      }
    } finally {
      controller.abort();
      for (const stream of Object.values(runtime?.streams ?? {})) {
        stream.on("error", () => {});
        stream.destroy();
      }
      await f.close();
    }
  });
});
