import { describe, expect, it } from "@effect/vitest";
import { declare, initial, controlKey, fixture, runId, supervisor } from "./fixture.ts";
import {
  admit,
  check,
  entry,
  finish,
  install,
  mode,
  offer,
  requestFixture,
  requestProgress,
  requestPublisher,
} from "./requestFixture.ts";

describe("request-scoped durable execution", () => {
  it("deduplicates lost start and finish replies across 40 sequential requests using the same facet nonce", async () => {
    const f = await requestFixture();
    let client = f.client;
    let executions = 0;
    for (let i = 0; i < 40; i++) {
      const id = `step-${i}`;
      await client.call(offer(id));
      const accepted = await client.call(admit(id));
      expect(accepted.action).toBe("execute-once");
      if (accepted.action === "execute-once") executions++;
      expect(entry(accepted, id)).toMatchObject({
        generation: 1,
        facetNonce: "facet-1",
        status: "admitted",
      });
      // The parent lost the start reply; its resend reaches a fresh SQL client.
      client.close();
      client = f.file.open();
      expect(await client.call(offer(id))).toMatchObject({ action: "observe-only" });
      const duplicate = await client.call(admit(id));
      if (duplicate.action === "execute-once") executions++;
      expect(duplicate.action).toBe("observe-only");
      const before = client.raw();
      expect(await client.call(check(id))).toMatchObject({ action: "unchanged" });
      expect(client.raw()).toEqual(before);
      await client.call(requestProgress(1, id));
      await client.call(finish(id, 2));
      // Completion committed, but its reply was lost too.
      client.close();
      client = f.file.open();
      expect(await client.call(finish(id, 2))).toMatchObject({ action: "committed" });
      expect(await client.call(offer(id))).toMatchObject({ action: "committed" });
      const committed = await client.call(admit(id));
      if (committed.action === "execute-once") executions++;
      expect(committed.action).toBe("committed");
      expect(entry(committed, id).finish).toEqual(finish(id, 2).finish);
    }
    expect(executions).toBe(40);
    const result = await client.call({ type: "read", runId });
    expect(result.snapshot.requests?.entries).toHaveLength(40);
    expect(result.snapshot.requests?.facets).toHaveLength(1);
    expect(result.snapshot.requests?.checkpoint).toEqual(finish("step-39", 2).finish.checkpoint);
    expect(JSON.stringify(result)).not.toContain(requestPublisher().publisherKey);
  });

  it("allows only one outstanding request and makes input identity immutable", async () => {
    const { client } = await requestFixture();
    await client.call(offer());
    await expect(client.call(offer("next-step"))).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      client.call({ ...offer(), request: { ...offer().request, input: initial.seed.config } }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(client.call(check())).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(client.call(requestProgress())).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(client.call(finish())).rejects.toMatchObject({ code: "CONFLICT" });
    const competing = await Promise.all([client.call(admit()), client.call(admit())]);
    expect(competing.map((result) => result.action)).toEqual(["execute-once", "observe-only"]);
    await expect(client.call(offer("next-step"))).rejects.toMatchObject({ code: "CONFLICT" });
    await client.call(finish());
    await expect(client.call(check())).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await client.call(offer("next-step"))).toMatchObject({ action: "recorded" });
    await expect(
      client.call({ ...offer(), request: { ...offer().request, input: initial.seed.config } }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("preserves progress sequence, exact finish duplicates and terminal immutability", async () => {
    const { client } = await requestFixture();
    await client.call(offer());
    await client.call(admit());
    await expect(client.call(requestProgress(2))).rejects.toMatchObject({ code: "OUT_OF_ORDER" });
    await client.call(requestProgress());
    expect(await client.call(requestProgress())).toMatchObject({ action: "unchanged" });
    await expect(
      client.call({
        ...requestProgress(),
        progress: { ...requestProgress().progress, kind: "conflict" },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(client.call(finish("step-one", 3))).rejects.toMatchObject({
      code: "OUT_OF_ORDER",
    });
    const failed = {
      ...finish("step-one", 2),
      finish: { ...finish("step-one", 2).finish, status: "failed" },
    };
    await client.call(failed);
    expect(await client.call(failed)).toMatchObject({ action: "committed" });
    await expect(client.call(finish("step-one", 2))).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(client.call(requestProgress(2))).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("keeps request mode controller-owned and mutually exclusive with legacy invocation mode", async () => {
    const client = fixture().open();
    await client.call(initial);
    await expect(
      client.call({ ...mode, controlKey: supervisor.supervisorKey }),
    ).rejects.toMatchObject({ code: "STALE_SUPERVISOR" });
    await client.call(declare);
    await expect(client.call(mode)).rejects.toMatchObject({ code: "CONFLICT" });
    const f = await requestFixture();
    expect(await f.client.call(mode)).toMatchObject({ action: "unchanged" });
    await expect(f.client.call({ ...mode, requestId: "different-mode" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(f.client.call(declare)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      f.client.call({ ...install(2), controlKey: supervisor.supervisorKey }),
    ).rejects.toMatchObject({ code: "STALE_SUPERVISOR" });
    await expect(
      f.client.call({ ...offer(), supervisor: { ...supervisor, supervisorKey: controlKey } }),
    ).rejects.toMatchObject({ code: "STALE_SUPERVISOR" });
  });
});
