import { describe, expect, it } from "vite-plus/test";
import {
  createHarnessNodeBuiltinInventory,
  inspectNodeBuiltinFunctionCapabilities,
} from "../../NodeBuiltinInventory.ts";
import { fixture } from "./fixture.ts";

describe("runtime inventory declarations for retained unknown adapters", () => {
  it("keeps limited and unavailable adapters blocked and proves declared pipe behavior", async () => {
    const f = fixture();
    const inventory = createHarnessNodeBuiltinInventory(f.input, new AbortController().signal);
    try {
      const requests = [
        ["child_process", "ChildProcess"],
        ["child_process", "spawn"],
        ["child_process", "exec"],
        ["child_process", "execFile"],
        ["child_process", "spawnSync"],
        ["child_process", "execSync"],
        ["child_process", "execFileSync"],
        ["dns", "lookup"],
        ["dns", "promises", "lookup"],
        ["dns/promises", "lookup"],
        ["dns/promises", "Resolver"],
        ["module", "createRequire"],
        ["readline", "createInterface"],
        ["process", "stdin", "pause"],
        ["process", "stdin", "resume"],
        ["process", "stdin", "unshift"],
        ["process", "stdout", "off"],
        ["tty", "ReadStream"],
        ["tty", "isatty"],
      ].map(([specifier, ...memberPath]) => ({ specifier: specifier!, memberPath }));
      const records = inspectNodeBuiltinFunctionCapabilities(inventory.modules, requests);
      expect(records.map(({ status }) => status)).toEqual([
        "conditional",
        "conditional",
        "conditional",
        "conditional",
        "unsupported",
        "unsupported",
        "unsupported",
        "conditional",
        "conditional",
        "conditional",
        "conditional",
        "conditional",
        "conditional",
        "supported",
        "supported",
        "supported",
        "supported",
        "unsupported",
        "supported",
      ]);
      for (const record of records.filter(({ status }) => status === "unsupported")) {
        const module = inventory.modules[record.specifier]!;
        const callable: unknown = Reflect.get(module, record.memberPath[0]!);
        expect(record.failure).toEqual({ kind: "named-error", code: "ENOTSUP" });
        expect(() => {
          if (typeof callable !== "function") throw new TypeError("Expected a callable");
          Reflect.apply(callable, module, []);
        }).toThrowError(expect.objectContaining({ code: record.failure?.code }));
      }
      const process = inventory.modules.process!;
      const stdin = Reflect.get(process, "stdin");
      const stdout = Reflect.get(process, "stdout");
      expect(stdin.pause()).toBe(stdin);
      expect(stdin.isPaused()).toBe(true);
      expect(stdin.unshift("retained pipe bytes")).toBe(true);
      expect(stdin.read().toString()).toBe("retained pipe bytes");
      expect(stdin.resume()).toBe(stdin);
      expect(stdin.isPaused()).toBe(false);
      const listener = () => undefined;
      stdout.on("drain", listener);
      expect(stdout.off("drain", listener)).toBe(stdout);
      expect(stdout.listeners("drain")).not.toContain(listener);
      const tty = inventory.modules.tty!;
      expect(Reflect.getOwnPropertyDescriptor(tty, "isatty")?.get).toBeUndefined();
      expect(Reflect.get(tty, "isatty")(0)).toBe(false);
      expect(Reflect.get(tty, "isatty")(1)).toBe(false);
    } finally {
      await inventory.dispose();
      await f.close();
    }
  });
});
