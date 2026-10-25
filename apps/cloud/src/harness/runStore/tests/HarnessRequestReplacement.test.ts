import { describe, expect, it } from "@effect/vitest";
import { initial, reference, replacement, runId, supervisor, takeover } from "./fixture.ts";
import {
  admit,
  check,
  entry,
  finish,
  install,
  offer,
  reconcile,
  requestFixture,
  requestProgress,
  requestPublisher,
} from "./requestFixture.ts";

describe("request restoration and publisher fencing", () => {
  it("copies the latest checkpoint, preserves pending input, and fences an old live publisher after replacement", async () => {
    const { file, client: old } = await requestFixture();
    await old.call(offer("committed-step"));
    await old.call(admit("committed-step"));
    await old.call(finish("committed-step"));
    await old.call(offer());
    await old.call(admit());
    await old.call(requestProgress());
    const fresh = file.open();
    await fresh.call(takeover);
    await expect(old.call(offer("stale-supervisor-step"))).rejects.toMatchObject({
      code: "STALE_SUPERVISOR",
    });
    const replaced = await fresh.call(install(2));
    expect(replaced.snapshot.requests?.facets.at(-1)).toMatchObject({
      generation: 2,
      facetNonce: "facet-2",
      checkpoint: finish("committed-step").finish.checkpoint,
    });
    expect(entry(replaced)).toMatchObject({
      request: offer().request,
      generation: 1,
      facetNonce: "facet-1",
      status: "indeterminate",
      progress: { sequence: 1 },
    });
    for (const command of [check(), requestProgress(2), finish("step-one", 2), admit()]) {
      await expect(old.call(command)).rejects.toMatchObject({ code: "PUBLISHER_DENIED" });
    }
    old.close();
    fresh.close();
    const restored = file.open();
    expect(entry(await restored.call({ type: "read", runId })).status).toBe("indeterminate");
    expect(await restored.call({ ...offer(), supervisor: replacement })).toMatchObject({
      action: "indeterminate",
    });
    await expect(restored.call(admit("step-one", 2))).rejects.toMatchObject({
      code: "PUBLISHER_DENIED",
    });
    await expect(
      restored.call({ ...offer("next"), supervisor: replacement }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const outcome = {
      type: "completed",
      status: "completed",
      result: reference("reconciled-result"),
      checkpoint: finish().finish.checkpoint,
    };
    const completed = await restored.call({ ...reconcile(), outcome });
    expect(completed.action).toBe("committed");
    expect(entry(completed).finish).toEqual({
      sequence: 2,
      status: "completed",
      result: outcome.result,
      checkpoint: outcome.checkpoint,
    });
    expect(completed.snapshot.requests?.checkpoint).toEqual(outcome.checkpoint);
    expect(await restored.call({ ...offer(), supervisor: replacement })).toMatchObject({
      action: "committed",
    });
    expect(await restored.call(admit("step-one", 2))).toMatchObject({ action: "committed" });
    expect(await restored.call({ ...reconcile(), outcome })).toMatchObject({ action: "committed" });
    await restored.call({ ...offer("next"), supervisor: replacement });
    expect(await restored.call(admit("next", 2))).toMatchObject({ action: "execute-once" });
  });

  it("parks unknown acceptance and only releases proven-not-applied input with a new input identity", async () => {
    const { client } = await requestFixture();
    await client.call(offer());
    await client.call(admit());
    await expect(
      client.call({ ...reconcile(), outcome: { type: "not-applied" } }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await client.call(install(2));
    await expect(
      client.call({
        ...reconcile(),
        controlKey: supervisor.supervisorKey,
        outcome: { type: "not-applied" },
      }),
    ).rejects.toMatchObject({ code: "STALE_SUPERVISOR" });
    const unknown = { ...reconcile(), outcome: { type: "unknown" } };
    expect(await client.call(unknown)).toMatchObject({ action: "indeterminate" });
    expect(await client.call(unknown)).toMatchObject({ action: "indeterminate" });
    await expect(client.call(offer("unreconciled-next"))).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await client.call(offer())).toMatchObject({ action: "indeterminate" });
    const proven = {
      ...reconcile(),
      evidence: reference("verified-not-applied"),
      outcome: { type: "not-applied" },
    };
    expect(await client.call(proven)).toMatchObject({ action: "not-applied" });
    expect(await client.call(proven)).toMatchObject({ action: "not-applied" });
    expect(await client.call(offer())).toMatchObject({ action: "not-applied" });
    expect(await client.call(admit("step-one", 2))).toMatchObject({ action: "not-applied" });
    await expect(
      client.call({ ...offer(), request: { ...offer().request, input: initial.seed.config } }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      client.call({ ...reconcile(), outcome: { type: "unknown" } }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await client.call(offer("explicit-new-input"));
    expect(await client.call(admit("explicit-new-input", 2))).toMatchObject({
      action: "execute-once",
    });
  });

  it("makes facet rebind idempotent and prevents nonce, generation and capability reuse", async () => {
    const { client } = await requestFixture();
    expect(await client.call(install())).toMatchObject({ action: "unchanged" });
    await expect(
      client.call({ ...install(), publisherKey: install(2).publisherKey }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      client.call({ ...install(2), facetNonce: install().facetNonce }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      client.call({ ...install(2), publisherKey: install().publisherKey }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await client.call(takeover);
    await expect(client.call(install())).rejects.toMatchObject({ code: "STALE_SUPERVISOR" });
    await expect(
      client.call({ ...offer("new-parent-step"), supervisor: replacement }),
    ).rejects.toMatchObject({ code: "STALE_SUPERVISOR" });
    await client.call(install(2));
    expect(await client.call(install(2))).toMatchObject({ action: "unchanged" });
    await expect(client.call(install())).rejects.toMatchObject({ code: "STALE_SUPERVISOR" });
    await expect(
      client.call({
        ...takeover,
        expectedEpoch: 2,
        claimId: "third",
        requestId: "third-takeover",
        supervisorKey: requestPublisher(2).publisherKey,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("does not turn a successful request.check into authority after generation replacement", async () => {
    const { file, client: old } = await requestFixture();
    await old.call(offer());
    await old.call(admit());
    expect(await old.call(check())).toMatchObject({ action: "unchanged" });
    const resume = Promise.withResolvers<void>();
    const delayedPublication = resume.promise.then(() => old.call(requestProgress()));
    await file.open().call(install(2));
    resume.resolve();
    await expect(delayedPublication).rejects.toMatchObject({ code: "PUBLISHER_DENIED" });
    await expect(old.call(check())).rejects.toMatchObject({ code: "PUBLISHER_DENIED" });
    const state = await old.call({ type: "read", runId });
    expect(entry(state)).toMatchObject({ status: "indeterminate", progress: null });
    expect(state.snapshot.requests?.checkpoint).toEqual(state.snapshot.requests?.initialCheckpoint);
  });
});
