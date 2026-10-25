// @effect-diagnostics nodeBuiltinImport:off - isolated in-memory SQLite, never live userdata.
import * as NodeSqlite from "node:sqlite";
import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";

import { createNodeFs } from "../../src/isolate/NodeFs.ts";
import type { FacetStorage } from "../../src/kernel/FacetSqliteStorage.ts";
import { KernelFileSystem } from "../../src/kernel/KernelFileSystem.ts";
import { KernelWakeRegistry } from "../../src/kernel/KernelWakeRegistry.ts";
import { createFacetFilePersistence } from "../../src/kernel/FacetFilePersistence.ts";
import { createMemoryFilePersistencePorts } from "../../src/kernel/MemoryFilePersistencePorts.ts";
import { verifySeededAssets } from "./proofAssets.ts";
import { seedToolScenario, verifyCommittedToolScenario } from "./proofScenario.ts";
import type { GuestObservation } from "./proofObservation.ts";
import { SCENARIO_EXPECTED_FILES, TOOL_SCENARIO } from "./toolScenario.ts";
import type { MockMessagesApi, MockToolResult } from "./mockMessages.ts";

const base = { repository: "claude-turn-proof", fork: "proof", commit: "fixture-base" };
const clock = () => 1_800_000_000_000_000_001n;

function sqliteStorage(database: NodeSqlite.DatabaseSync): FacetStorage {
  let transactionDepth = 0;
  return {
    sql: {
      get databaseSize() {
        return 0;
      },
      exec(query, ...bindings) {
        const statement = database.prepare(query);
        const values: NodeSqlite.SQLInputValue[] = bindings.map((value) =>
          value instanceof ArrayBuffer ? new Uint8Array(value) : value,
        );
        return statement.columns().length
          ? statement.all(...values)
          : (statement.run(...values), []);
      },
    },
    transactionSync(callback) {
      const name = `claude_proof_${transactionDepth++}`;
      database.exec(`SAVEPOINT ${name}`);
      try {
        const result = callback();
        database.exec(`RELEASE ${name}`);
        return result;
      } catch (error) {
        database.exec(`ROLLBACK TO ${name}`);
        database.exec(`RELEASE ${name}`);
        throw error;
      } finally {
        transactionDepth--;
      }
    },
  };
}

function filesystemFixture() {
  const database = new NodeSqlite.DatabaseSync(":memory:");
  const ports = createMemoryFilePersistencePorts();
  const wakes = new KernelWakeRegistry();
  const persistence = createFacetFilePersistence(sqliteStorage(database), clock, { wakes, ports });
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage: persistence.storage }],
    cwd: "/",
  });
  const fs = createNodeFs(filesystem);
  fs.fs.mkdirSync("/work", { recursive: true });
  const host = { filesystem, fs, ports, persistence };

  return {
    host,
    ports,
    close() {
      persistence.dispose();
      filesystem.dispose();
      wakes.dispose();
      database.close();
    },
  };
}

function successfulMock(): MockMessagesApi {
  const content: readonly unknown[] = [
    [{ type: "text", text: "1 initial line\n2 needle-before" }],
    "",
    "",
    "/work/source.txt:2:needle-after",
    "/work/new.txt\n/work/source.txt",
    "shell-proof\n",
  ];
  const toolResults: MockToolResult[] = TOOL_SCENARIO.map((tool, index) => ({
    toolUseId: `toolu_test_${index + 1}`,
    name: tool.name,
    content: content[index],
    is_error: false,
    raw: { type: "tool_result", tool_use_id: `toolu_test_${index + 1}`, content: content[index] },
  }));

  // This fixture stands in for observed Messages results only to exercise the verifier.
  return {
    fetch: async () => new Response("test-only fixture"),
    requests: [],
    toolResults,
    deniedRequests: [],
    complete: true,
  };
}

function successfulOutput(): GuestObservation {
  return {
    stdout: `${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`,
    stderr: "",
    errors: [],
    bunMissing: [],
    builtinMissing: [],
    milestones: [],
    exitCode: 0,
  };
}

function failOutput(): GuestObservation {
  return {
    stdout: `${JSON.stringify({ type: "result", subtype: "error", is_error: true })}\n`,
    stderr: "",
    errors: [],
    bunMissing: [],
    builtinMissing: [],
    milestones: [],
    exitCode: 1,
  };
}

function applyExpectedToolWrites(fs: ReturnType<typeof createNodeFs>) {
  const current = String(fs.fs.readFileSync("/work/source.txt", "utf8"));
  fs.fs.writeFileSync("/work/source.txt", current.replace("needle-before", "needle-after"));
  fs.fs.writeFileSync("/work/new.txt", SCENARIO_EXPECTED_FILES["/work/new.txt"]);
  fs.fs.writeFileSync("/work/shell.txt", SCENARIO_EXPECTED_FILES["/work/shell.txt"]);
}

function assetCatalog(assets: Readonly<Record<string, Uint8Array>>) {
  return Object.fromEntries(
    Object.entries(assets).map(([path, bytes]) => [
      path,
      {
        bytes: bytes.byteLength,
        sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
      },
    ]),
  );
}

describe("Claude committed tool scenario", () => {
  it("commits actual SQLite bytes and verifies the receipt tree", async () => {
    const fixture = filesystemFixture();
    try {
      seedToolScenario(fixture.host);
      applyExpectedToolWrites(fixture.host.fs);

      const evidence = await verifyCommittedToolScenario(
        fixture.host,
        successfulOutput(),
        successfulMock(),
      );

      expect(evidence.ok).toBe(true);
      expect(evidence.errors).toEqual([]);
      expect(evidence.files.every((file) => file.sqliteMatches && file.committedMatches)).toBe(
        true,
      );
      expect(fixture.ports.committedTurns).toHaveLength(1);
      const receipt = evidence.commitReceipt;
      expect(receipt?.status).toBe("ok");
      if (receipt?.status !== "ok") throw new Error("Expected successful test commit receipt");
      const committed = fixture.ports.inspectTree({ ...base, commit: receipt.value.commit });
      for (const [path, expected] of Object.entries(SCENARIO_EXPECTED_FILES))
        expect(committed?.[path]?.data).toEqual(new TextEncoder().encode(expected));
    } finally {
      fixture.close();
    }
  });

  it("rejects same-size wrong SQLite bytes despite successful tool and terminal results", async () => {
    const fixture = filesystemFixture();
    try {
      seedToolScenario(fixture.host);
      applyExpectedToolWrites(fixture.host.fs);
      fixture.host.fs.fs.writeFileSync("/work/source.txt", "initial line\nneedle-aftEr\n");

      const evidence = await verifyCommittedToolScenario(
        fixture.host,
        successfulOutput(),
        successfulMock(),
      );

      expect(evidence.ok).toBe(false);
      expect(evidence.errors).toContain("SQLite file mismatch: /work/source.txt");
      expect(evidence.errors).toContain("committed file bytes mismatch: /work/source.txt");
      expect(evidence.tools.every((tool) => tool.ok)).toBe(true);
      expect(fixture.ports.committedTurns).toHaveLength(1);
    } finally {
      fixture.close();
    }
  });

  it("rejects a missing expected file even when the remaining writes and results succeed", async () => {
    const fixture = filesystemFixture();
    try {
      seedToolScenario(fixture.host);
      applyExpectedToolWrites(fixture.host.fs);
      fixture.host.fs.fs.unlinkSync("/work/shell.txt");

      const evidence = await verifyCommittedToolScenario(
        fixture.host,
        successfulOutput(),
        successfulMock(),
      );

      expect(evidence.ok).toBe(false);
      expect(evidence.errors).toContain("SQLite file mismatch: /work/shell.txt");
      expect(evidence.errors).toContain("committed file bytes mismatch: /work/shell.txt");
      expect(evidence.tools.every((tool) => tool.ok)).toBe(true);
    } finally {
      fixture.close();
    }
  });

  it.each([
    { name: "failed terminal event", output: failOutput(), mockComplete: true },
    { name: "incomplete mock script", output: successfulOutput(), mockComplete: false },
  ])("does not commit after a $name", async ({ output, mockComplete }) => {
    const fixture = filesystemFixture();
    try {
      seedToolScenario(fixture.host);
      applyExpectedToolWrites(fixture.host.fs);
      const mock = { ...successfulMock(), complete: mockComplete };

      const evidence = await verifyCommittedToolScenario(fixture.host, output, mock);

      expect(evidence.ok).toBe(false);
      expect(evidence.commitReceipt).toBeUndefined();
      expect(fixture.ports.committedTurns).toHaveLength(0);
    } finally {
      fixture.close();
    }
  });
});

describe("Claude seeded asset verification", () => {
  it("verifies binary assets read back from the SQLite filesystem", async () => {
    const fixture = filesystemFixture();
    try {
      const assets = {
        "/assets/claude.bin": new Uint8Array([0, 255, 1, 2, 128]),
        "/assets/runtime.bin": new Uint8Array([9, 0, 9, 255]),
      };
      fixture.host.fs.fs.mkdirSync("/assets", { recursive: true });
      for (const [path, bytes] of Object.entries(assets))
        fixture.host.fs.fs.writeFileSync(path, bytes);

      const result = await verifySeededAssets(fixture.host.fs, assetCatalog(assets));

      expect(result).toMatchObject({
        ok: true,
        source: "sqlite-filesystem",
        expectedAssets: 2,
        readAssets: 2,
        verifiedAssets: 2,
        verifiedBytes: 9,
        errors: [],
      });
      expect(result.expectedCatalogSha256).toBe(result.actualCatalogSha256);
    } finally {
      fixture.close();
    }
  });

  it("rejects same-size corruption and a missing asset while counting only verified bytes", async () => {
    const fixture = filesystemFixture();
    try {
      const good = new Uint8Array([0, 255, 1]);
      const expectedCorrupt = new Uint8Array([10, 20, 30, 40]);
      const assets = {
        "/assets/good.bin": good,
        "/assets/corrupt.bin": expectedCorrupt,
        "/assets/missing.bin": new Uint8Array([4, 5]),
      };
      fixture.host.fs.fs.mkdirSync("/assets", { recursive: true });
      fixture.host.fs.fs.writeFileSync("/assets/good.bin", good);
      fixture.host.fs.fs.writeFileSync("/assets/corrupt.bin", new Uint8Array([10, 20, 31, 40]));

      const result = await verifySeededAssets(fixture.host.fs, assetCatalog(assets));

      expect(result).toMatchObject({
        ok: false,
        source: "sqlite-filesystem",
        expectedAssets: 3,
        readAssets: 2,
        verifiedAssets: 1,
        verifiedBytes: good.byteLength,
      });
      expect(result.errors).toEqual([
        { path: "/assets/corrupt.bin", reason: expect.stringContaining("SHA-256 mismatch") },
        { path: "/assets/missing.bin", reason: expect.any(String) },
      ]);
      expect(result.expectedCatalogSha256).not.toBe(result.actualCatalogSha256);
    } finally {
      fixture.close();
    }
  });
});
