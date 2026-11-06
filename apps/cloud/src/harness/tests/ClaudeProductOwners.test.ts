import { describe, expect, it } from "vite-plus/test";
import {
  createClaudeProductOwners,
  type ClaudeProductOwnerRuntime,
} from "../ClaudeProductOwners.ts";

// Startup must never read an owner's tens of MB of code; touching it here throws.
const untouchable = () =>
  new Proxy(
    {},
    {
      get() {
        throw new Error("Owner code was read at startup");
      },
    },
  ) as WorkerLoaderWorkerCode;

describe("Claude product owners", () => {
  it("keys each owner's Worker by its build and the CLI's by its release too, without reading code", () => {
    const loaded: string[] = [];
    const opened: string[] = [];
    const runtime = (
      versions: ClaudeProductOwnerRuntime["versions"],
    ): ClaudeProductOwnerRuntime => ({
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
        kernel: untouchable(),
        cli: untouchable(),
        computer: untouchable(),
        sdk: untouchable(),
      },
      versions,
    });
    const first = { kernel: "k1", cli: "c1", computer: "x1", sdk: "s1" };
    createClaudeProductOwners(runtime(first), "machine", "release-a").dispose();
    createClaudeProductOwners(runtime({ ...first, cli: "c2" }), "machine", "release-a").dispose();
    createClaudeProductOwners(runtime(first), "machine", "release-b").dispose();
    createClaudeProductOwners(runtime(first), "machine", "release-a").dispose();
    const keys = (role: string) => loaded.filter((key) => key.startsWith(`machine:${role}:`));
    // A new CLI build or a new Claude release each get their own CLI Worker; nothing else moves.
    expect(new Set(keys("cli")).size).toBe(3);
    expect(new Set(keys("kernel")).size).toBe(1);
    expect(keys("cli")[0]).toBe(keys("cli")[3]);
    expect(new Set(opened)).toEqual(new Set(["machine:kernel", "machine:cli", "machine:computer"]));
  });
});
