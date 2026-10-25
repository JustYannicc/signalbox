import { describe, expect, it } from "@effect/vitest";
import {
  complete,
  controlKey,
  declaration,
  declare,
  fixture,
  initial,
  intent,
  progress,
  receipt,
  replacement,
  runId,
  supervisor,
  takeover,
} from "./fixture.ts";

describe("durable supervisor authority", () => {
  it("rehydrates seed, readiness receipts and control intent in entirely new database clients", async () => {
    const file = fixture();
    const old = file.open();
    await old.call(initial);
    await old.call(receipt());
    await old.call(intent());
    old.close();
    const fresh = file.open();
    const result = await fresh.call({ type: "read", runId });
    expect(result.snapshot.seed).toEqual(initial.seed);
    expect(result.snapshot.receipts).toEqual([{ ...receipt().receipt, epoch: 1 }]);
    expect(result.snapshot.intents).toEqual([
      { ...intent().intent, epoch: 1, claimId: supervisor.claimId },
    ]);
    expect(await fresh.call(initial)).toMatchObject({
      action: "unchanged",
      snapshot: result.snapshot,
    });
    expect(await fresh.call(receipt())).toMatchObject({ action: "unchanged" });
    expect(await fresh.call(intent())).toMatchObject({ action: "unchanged" });
    await expect(
      fresh.call({
        ...initial,
        seed: { ...initial.seed, config: { ...initial.seed.config, id: "different" } },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      fresh.call({ ...initial, controlKey: "stolen-capability-".repeat(3) }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("atomically takes over once, rejects stale scheduling and control, and retains native publication", async () => {
    const file = fixture();
    const old = file.open();
    await old.call(initial);
    expect(await old.call(declare)).toMatchObject({ action: "launch-once" });
    const fresh = file.open();
    const claims = await Promise.allSettled([
      fresh.call(takeover),
      old.call({ ...takeover, claimId: "competitor", requestId: "competing-takeover" }),
    ]);
    expect(claims[0]).toMatchObject({
      status: "fulfilled",
      value: { snapshot: { supervisor: { epoch: 2 } } },
    });
    expect(claims[1]).toMatchObject({ status: "rejected", reason: { code: "STALE_SUPERVISOR" } });
    expect(await fresh.call(takeover)).toMatchObject({ action: "unchanged" });
    for (const command of [
      declare,
      intent(),
      receipt(),
      { type: "retirePublisher", runId, supervisor },
    ]) {
      await expect(old.call(command)).rejects.toMatchObject({ code: "STALE_SUPERVISOR" });
    }
    expect(await old.call(progress(1))).toMatchObject({ snapshot: { progress: { sequence: 1 } } });
    expect(await old.call(complete(2))).toMatchObject({
      snapshot: { terminal: { reference: { id: "native-result" } } },
    });
    old.close();
    fresh.close();
    expect(await file.open().call({ type: "read", runId })).toMatchObject({
      snapshot: {
        supervisor: { epoch: 2, claimId: replacement.claimId },
        terminal: { sequence: 2 },
        invocation: { declaration },
      },
    });
  });

  it("fences an old in-flight supervisor write after takeover without stopping the native call", async () => {
    const client = fixture().open();
    await client.call(initial);
    await client.call(declare);
    const continuation = Promise.withResolvers<void>();
    const oldParent = continuation.promise.then(() => client.call(intent()));
    await client.call(takeover);
    continuation.resolve();
    await expect(oldParent).rejects.toMatchObject({ code: "STALE_SUPERVISOR" });
    await client.call(complete(1));
    expect(await client.call({ type: "read", runId })).toMatchObject({
      snapshot: { intents: [], terminal: { sequence: 1 }, supervisor: { epoch: 2 } },
    });
  });

  it("never grants a second launch or a replacement incarnation after declaration", async () => {
    const file = fixture();
    const first = file.open();
    await first.call(initial);
    expect(await first.call(declare)).toMatchObject({ action: "launch-once" });
    first.close();
    const fresh = file.open();
    expect(await fresh.call(declare)).toMatchObject({ action: "observe-only" });
    await fresh.call(takeover);
    expect(await fresh.call({ ...declare, supervisor: replacement })).toMatchObject({
      action: "observe-only",
    });
    await expect(
      fresh.call({
        ...declare,
        supervisor: replacement,
        declaration: { ...declaration, nativeIncarnationId: "replacement-native" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      fresh.call({
        ...declare,
        supervisor: replacement,
        publisherKey: "stolen-publisher-".repeat(3),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      fresh.call({ type: "retirePublisher", runId, supervisor: replacement }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const read = await fresh.call({ type: "read", runId });
    const serialized = JSON.stringify(read);
    expect(serialized).not.toContain(controlKey);
    expect(serialized).not.toContain(supervisor.supervisorKey);
    expect(serialized).not.toContain(replacement.supervisorKey);
    expect(serialized).not.toContain(declare.publisherKey);
    await expect(
      fresh.call({
        ...intent(),
        supervisor: { ...replacement, supervisorKey: "unknown-supervisor-".repeat(3) },
      }),
    ).rejects.toMatchObject({ code: "STALE_SUPERVISOR" });
  });

  it("does not revive old claims or reuse claim and request identities", async () => {
    const client = fixture().open();
    await client.call(initial);
    await client.call(takeover);
    await client.call({
      ...takeover,
      expectedEpoch: 2,
      claimId: "parent-three",
      requestId: "takeover-three",
      supervisorKey: "supervisor-three-key-".repeat(3),
    });
    await expect(client.call(takeover)).rejects.toMatchObject({ code: "STALE_SUPERVISOR" });
    await expect(client.call({ ...takeover, expectedEpoch: 3 })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(
      client.call({ ...takeover, expectedEpoch: 3, requestId: "new-request" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      client.call({
        ...takeover,
        expectedEpoch: 3,
        claimId: "parent-four",
        requestId: "new-request",
        controlKey: "wrong-key-".repeat(5),
      }),
    ).rejects.toMatchObject({ code: "STALE_SUPERVISOR" });
    await expect(
      client.call({ ...intent(), supervisor: { ...supervisor, epoch: 3 } }),
    ).rejects.toMatchObject({ code: "STALE_SUPERVISOR" });
  });

  it("prevents a stale supervisor from stealing the current claim or controller authority", async () => {
    const client = fixture().open();
    await client.call(initial);
    await client.call(takeover);
    await expect(
      client.call({
        ...intent(),
        supervisor: { ...replacement, supervisorKey: supervisor.supervisorKey },
      }),
    ).rejects.toMatchObject({ code: "STALE_SUPERVISOR" });
    await expect(
      client.call({
        ...takeover,
        expectedEpoch: 2,
        claimId: "thief",
        requestId: "steal-authority",
        controlKey: supervisor.supervisorKey,
        supervisorKey: "thief-supervisor-key-".repeat(3),
      }),
    ).rejects.toMatchObject({ code: "STALE_SUPERVISOR" });
    await expect(
      client.call({
        ...takeover,
        expectedEpoch: 2,
        claimId: "parent-three",
        requestId: "reuse-old-key",
        supervisorKey: supervisor.supervisorKey,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      client.call({
        ...takeover,
        expectedEpoch: 2,
        claimId: "parent-three",
        requestId: "reuse-controller-key",
        supervisorKey: controlKey,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      client.call({ ...declare, supervisor: replacement, publisherKey: replacement.supervisorKey }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const fresh = await client.call({ ...intent("current-intent"), supervisor: replacement });
    expect(fresh.snapshot.supervisor).toMatchObject({ epoch: 2, claimId: "parent-two" });
  });
});
