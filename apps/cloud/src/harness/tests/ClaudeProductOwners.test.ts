import { describe, expect, it } from "vite-plus/test";
import { createClaudeProductOwners } from "../ClaudeProductOwners.ts";

const code = (source: string) =>
  ({
    compatibilityDate: "2026-10-01",
    mainModule: "main.js",
    modules: { "main.js": source },
  }) as unknown as WorkerLoaderWorkerCode;

describe("Claude product owners", () => {
  it("loads each owner's Worker by its code, so two releases' owners never mix", async () => {
    const loaded: string[] = [];
    const opened: string[] = [];
    const runtime = (cli: string) => ({
      loader: {
        get(key: string) {
          loaded.push(key);
          return { getDurableObjectClass: () => ({}), getEntrypoint: () => ({}) };
        },
      } as unknown as WorkerLoader,
      facets: {
        get(key: string) {
          opened.push(key);
          return {};
        },
        abort() {},
        delete() {},
      } as unknown as DurableObjectState["facets"],
      code: {
        kernel: code("kernel"),
        cli: code(cli),
        computer: code("computer"),
        sdk: code("sdk"),
      },
    });
    (await createClaudeProductOwners(runtime("cli, first release"), "machine")).dispose();
    (await createClaudeProductOwners(runtime("cli, next release"), "machine")).dispose();
    const cli = loaded.filter((key) => key.startsWith("machine:cli:"));
    const kernel = loaded.filter((key) => key.startsWith("machine:kernel:"));
    expect(new Set(cli).size).toBe(2);
    expect(new Set(kernel).size).toBe(1);
    // Facets keep their names, and so their storage, from one release to the next.
    expect(new Set(opened)).toEqual(new Set(["machine:kernel", "machine:cli", "machine:computer"]));
  });
});
