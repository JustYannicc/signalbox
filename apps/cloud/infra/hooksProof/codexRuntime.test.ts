import { parse } from "smol-toml";
import { ChildWorkerCapacity } from "../../src/computer/ChildWorkerCapacity.ts";
import { describe, expect, it } from "vite-plus/test";
import { createFacetSqliteStorage } from "../../src/kernel/FacetSqliteStorage.ts";
import { KernelFileSystem } from "../../src/kernel/KernelFileSystem.ts";
import { KernelWakeRegistry } from "../../src/kernel/KernelWakeRegistry.ts";
import { createProofTestStorage } from "../claudeTurnProof/proofTestStorage.ts";
import { createCodexHookRuntime } from "./codexRuntime.ts";
import { CODEX_HOOK_REGISTRATIONS, codexHookRequirements } from "./codexScenario.ts";

function fixture() {
  const database = createProofTestStorage();
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage: createFacetSqliteStorage(database.storage, () => 1n) }],
    posix: {
      credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000, groups: [] },
      umask: 0o022,
    },
  });
  filesystem.mkdir("/workspace");
  const wakes = new KernelWakeRegistry();
  const runtime = createCodexHookRuntime(
    new WebAssembly.Module(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0)),
    wakes,
    new ChildWorkerCapacity(),
  );
  return {
    database,
    runtime,
    input: {
      filesystem,
      facetStorage: database.storage,
      host: runtime.host,
      wakes,
      env: {
        CHILD_WORKERS: {},
        CODE_GENERATION: {
          async open(): Promise<never> {
            throw new Error("Setup must not execute generated code");
          },
        },
      },
    },
    async close() {
      await runtime.host.processes.dispose();
      filesystem.dispose();
      wakes.dispose();
      database.close();
    },
  };
}

describe("Codex hook fixture setup", () => {
  it("composes a parseable managed policy containing every native hook event", () => {
    const policy = parse(codexHookRequirements());
    expect(policy.allow_managed_hooks_only).toBe(true);
    expect(policy.features).toEqual({ hooks: true });
    const hooks = policy.hooks;
    expect(hooks).toMatchObject({ managed_dir: "/usr/bin" });
    expect(JSON.stringify(hooks)).toContain(CODEX_HOOK_REGISTRATIONS[0]!.id);
    expect(JSON.stringify(hooks)).toContain(CODEX_HOOK_REGISTRATIONS[1]!.id);
    expect(JSON.stringify(hooks)).toContain(CODEX_HOOK_REGISTRATIONS[2]!.id);
    expect(JSON.stringify(hooks)).toContain(CODEX_HOOK_REGISTRATIONS[3]!.id);
  });

  it("creates generated-code tables in raw facet storage and drains its engine identity", async () => {
    const test = fixture();
    try {
      const configured = test.runtime.configure(test.input);
      expect(test.runtime.host.processes.size).toBe(1);
      expect([
        ...test.database.storage.sql.exec(
          "SELECT name FROM sqlite_master WHERE name = 'node_generated_code_v1'",
        ),
      ]).toEqual([{ name: "node_generated_code_v1" }]);
      await configured.finish({ exit: 0, failure: undefined });
    } finally {
      await test.close();
    }
    expect(test.runtime.host.processes.size).toBe(0);
  });

  it("does not leave a live engine identity when generated storage setup fails", async () => {
    const test = fixture();
    const failure = new Error("Generated storage setup failed");
    try {
      expect(() =>
        test.runtime.configure({
          ...test.input,
          facetStorage: {
            ...test.database.storage,
            sql: {
              databaseSize: 0,
              exec() {
                throw failure;
              },
            },
          },
        }),
      ).toThrow(failure);
      expect(test.runtime.host.processes.size).toBe(0);
    } finally {
      await test.close();
    }
  });
});
