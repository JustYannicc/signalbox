import * as NodeAssert from "node:assert/strict";
import * as NodeSqlite from "node:sqlite";
import * as NodeTest from "node:test";
import { createFacetSqliteStorage } from "../../src/kernel/FacetSqliteStorage.ts";
import { KernelProgramRegistry } from "../../src/kernel/KernelAbi.ts";
import { KernelFileSystem } from "../../src/kernel/KernelFileSystem.ts";
import { KernelProgramHost } from "../../src/kernel/KernelProgramHost.ts";
import { KernelWakeRegistry } from "../../src/kernel/KernelWakeRegistry.ts";
import { createProofExec } from "./ProofExec.mjs";
import {
  initializeProofDirectories,
  initializeProofRoot,
  proofCredentials,
  proofEnvironment,
  verifyPatchResult,
} from "./ProofWorkspace.mjs";

function sqliteFixture() {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  let depth = 0;
  const storage = {
    sql: {
      get databaseSize() {
        return 0;
      },
      exec(query, ...bindings) {
        const statement = db.prepare(query);
        const values = bindings.map((value) =>
          value instanceof ArrayBuffer ? new Uint8Array(value) : value,
        );
        return statement.columns().length
          ? statement.all(...values)
          : (statement.run(...values), []);
      },
    },
    transactionSync(callback) {
      const name = `proof_test_${depth++}`;
      db.exec(`SAVEPOINT ${name}`);
      try {
        const result = callback();
        db.exec(`RELEASE ${name}`);
        return result;
      } catch (error) {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
        throw error;
      } finally {
        depth--;
      }
    },
  };
  return { storage, close: () => db.close() };
}

NodeTest.test(
  "exec handshake file URIs address the same filesystem as the proof workspace",
  async () => {
    const fixture = sqliteFixture();
    const storage = createFacetSqliteStorage(fixture.storage, () => 1n);
    initializeProofRoot(storage);
    const filesystem = new KernelFileSystem({
      mounts: [{ path: "/", storage }],
      posix: { credentials: proofCredentials, umask: 0o022 },
    });
    initializeProofDirectories(filesystem);
    const wakes = new KernelWakeRegistry();
    const host = new KernelProgramHost({ registry: new KernelProgramRegistry(), wakes });
    const cleanupErrors = [];
    const sessions = createProofExec({ filesystem, host, transcript: [], cleanupErrors });
    const messages = [];
    const connection = sessions.connect((message) => messages.push(message));
    try {
      await connection.receive(
        JSON.stringify({ id: 1, method: "initialize", params: { clientName: "codex" } }),
      );
      const environment = messages.at(-1).result.environmentInfo;
      NodeAssert.equal(environment.shell.path, "/bin/bash");
      for (const [field, path] of [
        ["cwd", "/workspace"],
        ["userHomeDir", "/home/codex"],
        ["tempDir", "/tmp"],
      ]) {
        const uri = new URL(environment[field]);
        NodeAssert.equal(uri.protocol, "file:");
        NodeAssert.equal(uri.hostname, "");
        NodeAssert.equal(uri.pathname, path);
      }
      NodeAssert.equal(proofEnvironment.HOME, "/home/codex");
      NodeAssert.equal(proofEnvironment.PWD, "/workspace");
      await connection.receive(JSON.stringify({ method: "initialized" }));
      const path = new URL("proof.txt", environment.cwd + "/").href;
      await connection.receive(
        JSON.stringify({
          id: 2,
          method: "fs/writeFile",
          params: { path, dataBase64: "Y29kZXgtcGF0Y2gtcHJvb2YK" },
        }),
      );
      NodeAssert.deepEqual(messages.at(-1), { id: 2, result: {} });
      NodeAssert.equal(verifyPatchResult(filesystem), "codex-patch-proof\n");
      await connection.receive(JSON.stringify({ id: 3, method: "fs/readFile", params: { path } }));
      NodeAssert.deepEqual(messages.at(-1), {
        id: 3,
        result: { dataBase64: "Y29kZXgtcGF0Y2gtcHJvb2YK" },
      });
    } finally {
      await sessions.dispose();
      await host.processes.dispose();
      filesystem.dispose();
      wakes.dispose();
      fixture.close();
    }
    NodeAssert.deepEqual(cleanupErrors, []);
  },
);
