import { parse } from "smol-toml";
import { ChildWorkerCapacity } from "../../src/computer/ChildWorkerCapacity.ts";
import { describe, expect, it } from "vite-plus/test";
import { createFacetSqliteStorage } from "../../src/kernel/FacetSqliteStorage.ts";
import { KernelFileSystem, KernelOpenFlags } from "../../src/kernel/KernelFileSystem.ts";
import { KernelWakeRegistry } from "../../src/kernel/KernelWakeRegistry.ts";
import { createProofTestStorage } from "../claudeTurnProof/proofTestStorage.ts";
import { createCodexHookRuntime } from "./codexRuntime.ts";
import { STANDARD_PROOF_WRITE } from "./standardProofAdapter.ts";
import {
  CODEX_HOOK_REGISTRATIONS,
  CODEX_STANDARD_HOOK_IDS,
  PRE_TOOL_USE_CAPTURE_PATH,
  codexHookRequirements,
} from "./codexScenario.ts";

function fixture() {
  const database = createProofTestStorage();
  const storage = createFacetSqliteStorage(database.storage, () => 1n);
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage }],
    posix: {
      credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000, groups: [] },
      umask: 0o022,
    },
  });
  filesystem.mkdir("/workspace");
  const wakes = new KernelWakeRegistry();
  const runtime = createCodexHookRuntime(
    () => ({ bindings: new Map(), async drain() {} }),
    wakes,
    new ChildWorkerCapacity(10),
  );
  return {
    database,
    runtime,
    input: {
      filesystem,
      storage,
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
  it("inspects new session bytes under the native bootstrap home", async () => {
    const test = fixture();
    const { filesystem } = test.input;
    let configured: ReturnType<typeof test.runtime.configure> | undefined;
    try {
      for (const path of ["/home", "/home/codex", "/home/codex/sessions"]) filesystem.mkdir(path);
      const bytes = new TextEncoder().encode(JSON.stringify({ text: STANDARD_PROOF_WRITE }) + "\n");
      const path = "/home/codex/sessions/native.jsonl";
      const fd = filesystem.open(path, KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY);
      try {
        filesystem.write(fd, bytes, null);
        configured = test.runtime.configure(test.input);
        const stale = await configured.verify({ filesystem });
        expect(stale.sessionMirror).toMatchObject({ ok: false, files: 1, newBytes: 0 });
        filesystem.write(fd, bytes, null);
        const fresh = await configured.verify({ filesystem });
        expect(fresh.sessionMirror).toMatchObject({
          ok: true,
          files: 1,
          bytes: bytes.byteLength * 2,
          newBytes: bytes.byteLength,
          placeholderNames: ["API_TOKEN", "VAULT_TOKEN"],
          unexpectedRawSecret: false,
        });
      } finally {
        filesystem.close(fd);
      }
    } finally {
      await configured?.finish({ exit: 0, failure: undefined });
      await test.close();
    }
  });

  it("resets the previous run's hook capture while preserving workspace files", async () => {
    const test = fixture();
    const { filesystem } = test.input;
    try {
      const first = test.runtime.configure(test.input);
      const bytes = new TextEncoder().encode("previous native hook input\n");
      for (const path of [PRE_TOOL_USE_CAPTURE_PATH, "/workspace/keep.txt"]) {
        const fd = filesystem.open(path, KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY);
        try {
          filesystem.write(fd, bytes, null);
        } finally {
          filesystem.close(fd);
        }
      }
      await first.finish({ exit: 0, failure: undefined });
      const second = test.runtime.configure(test.input);
      try {
        expect(filesystem.stat(PRE_TOOL_USE_CAPTURE_PATH).size).toBe(0n);
        const fd = filesystem.open("/workspace/keep.txt", KernelOpenFlags.O_RDONLY);
        try {
          const actual = new Uint8Array(bytes.byteLength);
          expect(filesystem.read(fd, actual, null)).toBe(bytes.byteLength);
          expect(actual).toEqual(bytes);
        } finally {
          filesystem.close(fd);
        }
      } finally {
        await second.finish({ exit: 0, failure: undefined });
      }
    } finally {
      await test.close();
    }
  });

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
    for (const id of Object.values(CODEX_STANDARD_HOOK_IDS))
      expect(JSON.stringify(hooks)).toContain(id);
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

  it("includes the standard adapter result after the engine has joined", async () => {
    const test = fixture();
    try {
      const configured = test.runtime.configure(test.input);
      await configured.finish({ exit: 0, failure: undefined });
      const result = await configured.verify({ filesystem: test.input.filesystem });
      expect(result).toMatchObject({ ok: false, standard: { ok: false } });
    } finally {
      await test.close();
    }
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
