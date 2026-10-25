import { describe, expect, it } from "@effect/vitest";
import {
  complete,
  declare,
  fixture,
  initial,
  intent,
  progress,
  publisher,
  receipt,
  replacement,
  runId,
  supervisor,
  takeover,
} from "./fixture.ts";

describe("durable native publication", () => {
  it("accepts only the declared publisher and keeps exact sequence and duplicate rules across reconstruction", async () => {
    const file = fixture();
    const old = file.open();
    await old.call(initial);
    await expect(old.call(progress(1))).rejects.toMatchObject({ code: "PUBLISHER_DENIED" });
    await old.call(declare);
    await expect(
      old.call({
        ...progress(1),
        publisher: { ...publisher, publisherKey: "wrong-native-key-".repeat(3) },
      }),
    ).rejects.toMatchObject({ code: "PUBLISHER_DENIED" });
    await expect(
      old.call({ ...progress(1), publisher: { ...publisher, invocationId: "unrelated-call" } }),
    ).rejects.toMatchObject({ code: "PUBLISHER_DENIED" });
    await expect(
      old.call({
        ...progress(1),
        publisher: { ...publisher, nativeIncarnationId: "other-native" },
      }),
    ).rejects.toMatchObject({ code: "PUBLISHER_DENIED" });
    await expect(old.call(progress(2))).rejects.toMatchObject({ code: "OUT_OF_ORDER" });
    await old.call(progress(1));
    old.close();
    const fresh = file.open();
    expect(await fresh.call(progress(1))).toMatchObject({ action: "unchanged" });
    await expect(
      fresh.call({
        ...progress(1),
        progress: { ...progress(1).progress, kind: "conflicting-output" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(fresh.call(complete(3))).rejects.toMatchObject({ code: "OUT_OF_ORDER" });
    await fresh.call(progress(2));
    await expect(fresh.call(progress(1))).rejects.toMatchObject({ code: "OUT_OF_ORDER" });
    await fresh.call(complete(3));
    fresh.close();
    const final = file.open();
    expect(await final.call(complete(3))).toMatchObject({
      action: "unchanged",
      snapshot: { progress: { sequence: 2 }, terminal: { sequence: 3 } },
    });
    await expect(
      final.call({ ...complete(3), terminal: { ...complete(3).terminal, status: "failed" } }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(final.call(progress(3))).rejects.toMatchObject({ code: "TERMINAL" });
  });

  it("keeps terminal results immutable through takeover and publisher retirement", async () => {
    const client = fixture().open();
    await client.call(initial);
    await client.call(declare);
    await client.call(complete(1));
    await client.call(takeover);
    await expect(
      client.call({
        ...complete(1),
        terminal: {
          ...complete(1).terminal,
          reference: { ...complete(1).terminal.reference, id: "overwritten" },
        },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await client.call({ type: "retirePublisher", runId, supervisor: replacement });
    expect(
      await client.call({ type: "retirePublisher", runId, supervisor: replacement }),
    ).toMatchObject({ action: "unchanged" });
    await expect(client.call(complete(1))).rejects.toMatchObject({ code: "PUBLISHER_DENIED" });
    await expect(client.call(progress(1))).rejects.toMatchObject({ code: "PUBLISHER_DENIED" });
    await expect(
      client.call({
        ...declare,
        supervisor: replacement,
        declaration: { ...declare.declaration, invocationId: "second-call" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await client.call({ type: "read", runId })).toMatchObject({
      snapshot: { terminal: complete(1).terminal, invocation: { retired: true } },
    });
  });

  it("preserves exact generic receipts and fenced control identities without inventing readiness", async () => {
    const client = fixture().open();
    await client.call(initial);
    expect(await client.call({ type: "read", runId })).toMatchObject({
      snapshot: { receipts: [] },
    });
    await client.call(receipt());
    await client.call(intent());
    await expect(
      client.call({
        ...receipt(),
        receipt: {
          ...receipt().receipt,
          evidence: { ...receipt().receipt.evidence, id: "different-proof" },
        },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      client.call({ ...intent(), intent: { ...intent().intent, kind: "different-control" } }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await client.call(takeover);
    expect(await client.call({ ...receipt(), supervisor: replacement })).toMatchObject({
      action: "unchanged",
    });
    await expect(client.call({ ...intent(), supervisor: replacement })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await client.call({ ...intent("new-supervisor-intent"), supervisor: replacement });
    expect(await client.call({ type: "read", runId })).toMatchObject({
      snapshot: { receipts: [{ epoch: 1 }], intents: [{ epoch: 1 }, { epoch: 2 }] },
    });
  });

  it("bounds record growth and permits exact duplicate readback at capacity", async () => {
    const client = fixture().open();
    await client.call(initial);
    for (let i = 0; i < 64; i++) await client.call(receipt(`receipt-${i}`));
    await expect(client.call(receipt("overflow"))).rejects.toMatchObject({ code: "LIMIT" });
    expect(await client.call(receipt("receipt-0"))).toMatchObject({ action: "unchanged" });
    const read = await client.call({ type: "read", runId });
    expect(read.snapshot.receipts).toHaveLength(64);
    for (let i = 0; i < 64; i++) await client.call(intent(`intent-${i}`));
    await expect(client.call(intent("overflow"))).rejects.toMatchObject({ code: "LIMIT" });
    expect(await client.call(intent("intent-0"))).toMatchObject({ action: "unchanged" });
    for (let epoch = 1; epoch < 64; epoch++)
      await client.call({
        ...takeover,
        expectedEpoch: epoch,
        claimId: `parent-${epoch + 1}`,
        requestId: `takeover-${epoch + 1}`,
        supervisorKey: `supervisor-for-epoch-${epoch + 1}-`.repeat(2),
      });
    await expect(
      client.call({
        ...takeover,
        expectedEpoch: 64,
        claimId: "parent-65",
        requestId: "takeover-65",
        supervisorKey: "supervisor-for-epoch-65-".repeat(2),
      }),
    ).rejects.toMatchObject({ code: "LIMIT" });
  });

  it("rolls back a failed transaction and permits the same publication on a fresh client", async () => {
    const file = fixture();
    const old = file.open();
    await old.call(initial);
    await old.call(declare);
    old.failWrite();
    await expect(old.call(complete(1))).rejects.toMatchObject({
      code: "STORAGE",
      cause: expect.objectContaining({ message: "Failure after writing, before commit" }),
    });
    old.close();
    const fresh = file.open();
    expect(await fresh.call({ type: "read", runId })).toMatchObject({
      snapshot: { terminal: null },
    });
    expect(await fresh.call(complete(1))).toMatchObject({
      action: "recorded",
      snapshot: { terminal: { sequence: 1 } },
    });
  });

  it("rejects malformed and cross-run operations without modifying durable state", async () => {
    const client = fixture().open();
    await expect(client.call({ type: "read", runId })).rejects.toMatchObject({ code: "MISSING" });
    await client.call(initial);
    const before = client.raw();
    for (const command of [
      { type: "read", runId: "other-run" },
      { ...declare, replacementAllowed: true },
      {
        ...initial,
        seed: { ...initial.seed, artifacts: Array.from({ length: 17 }, () => initial.seed.config) },
      },
      { ...intent(), intent: { ...intent().intent, intentId: "x".repeat(257) } },
      { ...progress(Number.MAX_SAFE_INTEGER + 1) },
    ])
      await expect(client.call(command)).rejects.toBeDefined();
    expect(client.raw()).toEqual(before);
    expect(await client.call({ type: "read", runId })).toMatchObject({
      snapshot: { supervisor: { epoch: supervisor.epoch }, invocation: null },
    });
  });
});
