import { describe, expect, it } from "@effect/vitest";
import { declare, fixture, initial, runId } from "./fixture.ts";
import { admit, entry, finish, install, mode, offer, requestFixture } from "./requestFixture.ts";

describe("bounded request storage", () => {
  it("rolls back the request-mode upgrade together with its durable format marker", async () => {
    const file = fixture();
    const first = file.open();
    await first.call(initial);
    first.failWrite();
    await expect(first.call(mode)).rejects.toMatchObject({ code: "STORAGE" });
    first.close();
    const fresh = file.open();
    const before = await fresh.call({ type: "read", runId });
    expect(before.snapshot.version).toBe(1);
    expect(before.snapshot.requests).toBeUndefined();
    expect(fresh.rows("SELECT version FROM harness_run_format")).toEqual([{ version: 1 }]);
    expect(await fresh.call(mode)).toMatchObject({ snapshot: { version: 2 } });
    expect(fresh.rows("SELECT version FROM harness_run_format")).toEqual([{ version: 2 }]);
  });

  it("cannot fall back to legacy launch authority if the request-mode record disappears", async () => {
    const { file, client } = await requestFixture();
    await client.call(offer());
    await client.call(admit());
    client.exec("UPDATE harness_run_state SET state_json = json_remove(state_json, '$.requests')");
    const before = client.raw();
    client.close();
    const fresh = file.open();
    for (const command of [{ type: "read", runId }, declare]) {
      await expect(fresh.call(command)).rejects.toMatchObject({ code: "CORRUPT" });
    }
    expect(fresh.raw()).toEqual(before);
  });

  it("retains every request identity at capacity and never silently evicts replay protection", async () => {
    const { file, client } = await requestFixture();
    for (let i = 0; i < 128; i++) {
      const id = `bounded-${i}`;
      await client.call(offer(id));
      await client.call(admit(id));
      await client.call(finish(id));
    }
    await expect(client.call(offer("overflow"))).rejects.toMatchObject({ code: "LIMIT" });
    client.close();
    const fresh = file.open();
    const oldest = await fresh.call(offer("bounded-0"));
    expect(oldest.action).toBe("committed");
    expect(entry(oldest, "bounded-0").finish).toEqual(finish("bounded-0").finish);
    expect(oldest.snapshot.requests?.entries).toHaveLength(128);
    expect(await fresh.call(admit("bounded-0"))).toMatchObject({ action: "committed" });
  });

  it("bounds facet history and preserves old publisher tombstones", async () => {
    const { client } = await requestFixture();
    for (let generation = 2; generation <= 64; generation++) await client.call(install(generation));
    await expect(client.call(install(65))).rejects.toMatchObject({ code: "LIMIT" });
    expect(await client.call(install(64))).toMatchObject({ action: "unchanged" });
    await expect(
      client.call({ ...install(65), facetNonce: install().facetNonce }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await client.call({ type: "read", runId })).snapshot.requests?.facets).toHaveLength(64);
  });

  it("rolls back a failed request admission and completion without inventing committed receipts", async () => {
    const { file, client } = await requestFixture();
    await client.call(offer());
    client.failWrite();
    await expect(client.call(admit())).rejects.toMatchObject({ code: "STORAGE" });
    client.close();
    const fresh = file.open();
    expect(entry(await fresh.call({ type: "read", runId })).status).toBe("offered");
    expect(await fresh.call(admit())).toMatchObject({ action: "execute-once" });
    fresh.failWrite();
    await expect(fresh.call(finish())).rejects.toMatchObject({ code: "STORAGE" });
    expect(entry(await fresh.call({ type: "read", runId }))).toMatchObject({
      status: "admitted",
      finish: null,
    });
    expect(await fresh.call(finish())).toMatchObject({ action: "committed" });
  });

  it.each([
    "UPDATE harness_run_format SET version = 1",
    "UPDATE harness_run_state SET state_json = json_set(json_remove(state_json, '$.requests'), '$.version', 1)",
    "UPDATE harness_run_state SET state_json = json_set(state_json, '$.requests.modeId', 3)",
    "UPDATE harness_run_state SET state_json = json_set(state_json, '$.requests.facets[0].generation', 2)",
    "UPDATE harness_run_state SET state_json = json_set(state_json, '$.requests.entries[0].facetNonce', 'wrong-nonce')",
    "UPDATE harness_run_state SET state_json = json_set(state_json, '$.requests.entries[0].generation', 2)",
    "UPDATE harness_run_state SET state_json = json_set(state_json, '$.requests.entries[0].status', 'completed')",
    "UPDATE harness_run_state SET state_json = json_set(state_json, '$.requests.entries[0].status', 'indeterminate')",
    "UPDATE harness_run_state SET state_json = json_set(state_json, '$.requests.checkpoint.native.id', 'invented-checkpoint')",
    "UPDATE harness_run_state SET state_json = json_remove(state_json, '$.requests.entries[0].reconciliation')",
  ])("preserves and rejects corrupt request state across reconstruction: %s", async (corrupt) => {
    const { file, client } = await requestFixture();
    await client.call(offer());
    await client.call(admit());
    client.exec(corrupt);
    const before = client.raw();
    client.close();
    const fresh = file.open();
    for (const command of [{ type: "read", runId }, admit(), install(2)]) {
      await expect(fresh.call(command)).rejects.toMatchObject({ code: "CORRUPT" });
    }
    expect(fresh.raw()).toEqual(before);
  });
});
