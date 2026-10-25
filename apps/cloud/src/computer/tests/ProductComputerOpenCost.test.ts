// @effect-diagnostics nodeBuiltinImport:off - the optional startup measurement writes only its requested evidence file.
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import { describe, expect, it, vi } from "vite-plus/test";
import { createProductComputer } from "../ProductComputer.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { emptyMachineFilesFixture, machineInventoryFixture } from "../machineInventoryTesting.ts";
import { createFacetSqliteStorage, type FacetStorage } from "../../kernel/FacetSqliteStorage.ts";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import { KernelWakeRegistry } from "../../kernel/KernelWakeRegistry.ts";
import { sqliteFixture } from "../sqliteTesting.ts";
import {
  validateMachineProgramInventory,
  type MachineProgramInventory,
} from "../MachineProgramInventory.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

describe("ProductComputer startup storage cost", () => {
  it("opens cold and warm without any SQL statement or machine lookup", async () => {
    const database = sqliteFixture();
    let observing = false;
    const counters = { statements: 0, reads: 0, writes: 0, transactions: 0 };
    const storage: FacetStorage = {
      sql: {
        databaseSize: 0,
        exec(query, ...bindings) {
          if (observing) {
            counters.statements++;
            if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(query)) counters.reads++;
            else counters.writes++;
          }
          return database.storage.sql.exec(query, ...bindings);
        },
      },
      transactionSync(callback) {
        if (observing) counters.transactions++;
        return database.storage.transactionSync(callback);
      },
    };
    const root = createFacetSqliteStorage(storage, () => 1n);
    root.posix.initialize(root.root, { uid: 1000, gid: 1000, mode: 0o755 });
    const filesystem = new KernelFileSystem({
      mounts: [{ path: "/", storage: root }],
      posix: { credentials: { uid: 1000, gid: 1000, euid: 1000, egid: 1000 }, umask: 0o022 },
    });
    const wakes = new KernelWakeRegistry();
    const files = emptyMachineFilesFixture();
    const lookup = vi.spyOn(files, "lookup");
    const code = { mainModule: "unused.js", modules: { "unused.js": "export default class {}" } };
    const inventoryFile = NodeProcess.env.SIGNALBOX_MACHINE_PATH_INVENTORY;
    const inventory: MachineProgramInventory =
      inventoryFile === undefined
        ? machineInventoryFixture([{ path: "/usr/bin/tool", mode: 0o755, uid: 0, gid: 0 }])
        : JSON.parse(NodeFS.readFileSync(inventoryFile, "utf8"));
    validateMachineProgramInventory(inventory);
    const open = () => {
      Object.assign(counters, { statements: 0, reads: 0, writes: 0, transactions: 0 });
      observing = true;
      const started = performance.now();
      try {
        const computer = createProductComputer({
          threadId: "startup-storage-cost",
          filesystem,
          wakes,
          capacity: new ChildWorkerCapacity(2),
          loader: {
            run: async () => {
              throw new Error("Startup dispatched a child");
            },
          },
          programs: {
            bash: code,
            busyboxCat: code,
            busyboxApplets: code,
            ripgrep: code,
            git: code,
            sed: code,
            coreutils: {
              echo: code,
              printf: code,
              ls: code,
              mkdir: code,
              rm: code,
              cp: code,
              mv: code,
              pwd: code,
              head: code,
              tail: code,
            },
          },
          machineInventory: inventory,
          machine: () => ({
            files,
            spawn: async () => {
              throw new Error("Startup started a machine");
            },
          }),
          signal: new AbortController().signal,
        });
        return { computer, cost: { elapsedMs: performance.now() - started, ...counters } };
      } finally {
        observing = false;
      }
    };
    try {
      const cold = open();
      await cold.computer.close();
      const warm = open();
      await warm.computer.close();
      for (const result of [cold.cost, warm.cost])
        expect(result).toMatchObject({ statements: 0, reads: 0, writes: 0, transactions: 0 });
      expect(lookup).not.toHaveBeenCalled();
      const output = NodeProcess.env.SIGNALBOX_MACHINE_PATH_COST_OUTPUT;
      if (output !== undefined)
        NodeFS.writeFileSync(
          output,
          JSON.stringify(
            { inventoryEntries: inventory.entries.length, cold: cold.cost, warm: warm.cost },
            null,
            2,
          ),
        );
    } finally {
      wakes.dispose();
      filesystem.dispose();
      database.close();
    }
  });
});
