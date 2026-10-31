import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";
import { KernelFileSystem } from "../../../../src/kernel/KernelFileSystem.ts";
import { KernelWakeRegistry } from "../../../../src/kernel/KernelWakeRegistry.ts";
import { sqliteFixture } from "../../../../src/harness/node/tests/sqliteFixture.ts";
import { preparedAssetsFixture } from "../../../../src/harness/node/tests/preparedAssetsFixture.ts";
import { CHILD_COREUTILS_COMMANDS } from "../../../../src/computer/ChildProgramSet.ts";
import { ProgramCatalog, MachineInventory } from "./computerConfiguration.ts";
import { calibrateClaudePreparedRelease } from "./claudeCalibration.ts";

vi.mock("cloudflare:workers", async () =>
  (await import("../../../../src/cloudflareWorkersTesting.ts")).createCloudflareWorkersMock(),
);

const decodeCatalog = Schema.decodeUnknownSync(ProgramCatalog);
const decodeInventory = Schema.decodeUnknownSync(MachineInventory);

it("retains the primary failure and both disposal errors while closing every resource", async () => {
  const database = sqliteFixture();
  const { fixture, loaded } = await preparedAssetsFixture();
  if (loaded.plan.harness !== "claude-code") throw new Error("Expected Claude fixture");
  const primary = new Error("Catalog read failed");
  const fileFailure = new Error("Filesystem disposal failed");
  const wakeFailure = new Error("Wake disposal failed");
  const disposeFiles = KernelFileSystem.prototype.dispose;
  const disposeWakes = KernelWakeRegistry.prototype.dispose;
  let filesClosed = false;
  let wakesClosed = false;
  const files = vi.spyOn(KernelFileSystem.prototype, "dispose").mockImplementation(function (
    this: KernelFileSystem,
  ) {
    disposeFiles.call(this);
    expect(() => this.chdir("/")).toThrow();
    filesClosed = true;
    throw fileFailure;
  });
  const wakes = vi.spyOn(KernelWakeRegistry.prototype, "dispose").mockImplementation(function (
    this: KernelWakeRegistry,
  ) {
    disposeWakes.call(this);
    expect(this.register(() => () => {})).toMatchObject({
      status: "error",
      error: { code: "CANCELLED" },
    });
    wakesClosed = true;
    throw wakeFailure;
  });
  const code = { mainModule: "entry.mjs", modules: { "entry.mjs": "export class Program {}" } };
  const catalog = decodeCatalog({
    sourceIdentity: "cleanup-test",
    codes: {
      bash: code,
      busyboxCat: code,
      busyboxApplets: code,
      productBusyboxApplets: code,
      ripgrep: code,
      coreutils: Object.fromEntries(CHILD_COREUTILS_COMMANDS.map((command) => [command, code])),
      git: code,
      sed: code,
      jq: code,
      ugrep: code,
    },
    files: { "/fixture": { bytes: 1, sha256: "a".repeat(64), mode: 0o644, uid: 1000, gid: 1000 } },
  });
  const digest = `sha256:${"a".repeat(64)}`;
  const inventory = decodeInventory({
    format: "signalbox-machine-files-v1",
    imageRef: `fixture@${digest}`,
    imageDigest: digest,
    platform: "linux/amd64",
    provenance: {
      sourceRevision: "b".repeat(40),
      sourceImageId: digest,
      dockerfile: "Dockerfile",
      captureSha256: "c".repeat(64),
    },
    path: ["/bin"],
    excludedRoots: [],
    entries: [],
  });
  try {
    const result = calibrateClaudePreparedRelease({
      ctx: { storage: database.storage },
      capability: {
        catalog: async () => catalog,
        inventory: async () => inventory,
        read: async () => {
          throw primary;
        },
      },
      release: {
        artifact: {
          ...fixture.options.identity,
          provider: "claude-code",
          releaseId: "baseline",
          fixtureIdentity: "cleanup-test",
          createdAt: "2026-10-31T00:00:00Z",
        },
        plan: loaded.plan,
        payloads: loaded.payloads,
      },
      home: "/workspace/.home/claude",
    });
    await expect(result).rejects.toMatchObject({ errors: [primary, fileFailure, wakeFailure] });
    expect(filesClosed).toBe(true);
    expect(wakesClosed).toBe(true);
  } finally {
    files.mockRestore();
    wakes.mockRestore();
    database.close();
  }
});
