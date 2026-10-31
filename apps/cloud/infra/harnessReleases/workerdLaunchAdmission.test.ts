import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { requireWorkerdLaunchAdmission } from "./workerdLaunchAdmission.ts";
import { captureWorkerdBuiltinInventory } from "./workerdBuiltinInventory.ts";

const createTestHarness = vi.hoisted(() =>
  vi.fn((): never => {
    throw new Error("Unexpected Wrangler start");
  }),
);
vi.mock("wrangler", () => ({ createTestHarness }));
vi.mock("esbuild", () => ({ build: vi.fn() }));

const directories = new Set<string>();

function reserved(overrides: Record<string, unknown> = {}) {
  return {
    reservationState: "RESERVED",
    reservationId: "test-batch",
    runId: "a37-r1",
    currentOwnerThreadId: "test-owner",
    exclusiveHoldActive: true,
    reservedUntilRelease: true,
    expiresAt: null,
    ...overrides,
  };
}

async function activeFile(value: unknown) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workerd-admission-"));
  directories.add(directory);
  const path = NodePath.join(directory, "ACTIVE.json");
  await NodeFSP.writeFile(path, JSON.stringify(value));
  vi.stubEnv("SIGNALBOX_WORKERD_ACTIVE", path);
  vi.stubEnv("SIGNALBOX_WORKERD_OWNER", "test-owner");
  vi.stubEnv("SIGNALBOX_WORKERD_BATCH", "test-batch");
  return path;
}

beforeEach(() => {
  createTestHarness.mockClear();
  vi.stubEnv("SIGNALBOX_WORKERD_ACTIVE", undefined);
  vi.stubEnv("SIGNALBOX_WORKERD_OWNER", undefined);
  vi.stubEnv("SIGNALBOX_WORKERD_BATCH", undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of directories)
    await NodeFSP.rm(directory, { recursive: true, force: true });
  directories.clear();
});

describe("Workerd launch admission", () => {
  it("refuses the normal native inventory entry point without an ACK before starting Wrangler", async () => {
    await expect(captureWorkerdBuiltinInventory([])).rejects.toThrow(
      "WORKERD_LAUNCH_REFUSED: Set SIGNALBOX_WORKERD_ACTIVE",
    );
    expect(createTestHarness).not.toHaveBeenCalled();
  });

  it("allows the calling owner and reservation batch even when the run profile has a different name", async () => {
    await activeFile(reserved());
    await expect(requireWorkerdLaunchAdmission()).resolves.toBeUndefined();
  });

  it.each([
    ["released", { reservationState: "RELEASED" }],
    ["another owner", { currentOwnerThreadId: "other-owner" }],
    ["another batch", { reservationId: "other-batch" }],
    ["no exclusive hold", { exclusiveHoldActive: false }],
    ["hold already ended", { reservedUntilRelease: false }],
    ["expiring record", { expiresAt: "2099-01-01T00:00:00Z" }],
    ["missing owner", { currentOwnerThreadId: undefined }],
    ["missing expiry", { expiresAt: undefined }],
  ])("refuses %s before starting Wrangler", async (_name, changes) => {
    await activeFile(reserved(changes));
    await expect(captureWorkerdBuiltinInventory([])).rejects.toThrow("WORKERD_LAUNCH_REFUSED");
    expect(createTestHarness).not.toHaveBeenCalled();
  });

  it("refuses an unreadable or malformed ACTIVE", async () => {
    const path = await activeFile(reserved());
    await NodeFSP.writeFile(path, "{");
    await expect(requireWorkerdLaunchAdmission()).rejects.toThrow("ACTIVE is unreadable, invalid");
    await NodeFSP.rm(path);
    await expect(requireWorkerdLaunchAdmission()).rejects.toThrow("ACTIVE is unreadable, invalid");
  });

  it("refuses a saved ACK path after the live reservation was released", async () => {
    const path = await activeFile(reserved({ reservationState: "RELEASED" }));
    const savedAck = NodePath.join(NodePath.dirname(path), "test-batch-ack.json");
    await NodeFSP.writeFile(savedAck, JSON.stringify(reserved()));
    vi.stubEnv("SIGNALBOX_WORKERD_ACTIVE", savedAck);
    await expect(requireWorkerdLaunchAdmission()).rejects.toThrow("absolute live ACTIVE.json");
  });

  it("reads the live reservation again on every launch check", async () => {
    const path = await activeFile(reserved());
    await requireWorkerdLaunchAdmission();
    await NodeFSP.writeFile(path, JSON.stringify(reserved({ reservationState: "RELEASED" })));
    await expect(requireWorkerdLaunchAdmission()).rejects.toThrow("WORKERD_LAUNCH_REFUSED");
  });
});
