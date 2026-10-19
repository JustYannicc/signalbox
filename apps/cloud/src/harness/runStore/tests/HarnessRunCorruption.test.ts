import { describe, expect, it } from "@effect/vitest";
import { declare, fixture, initial, runId } from "./fixture.ts";

describe("corrupt and unknown durable state", () => {
  it("refuses a second launch when both singleton rows are lost across reconstruction", async () => {
    const file = fixture();
    const first = file.open();
    await first.call(initial);
    expect(await first.call(declare)).toMatchObject({ action: "launch-once" });
    const schema = first.rows("SELECT type, name, sql FROM sqlite_master ORDER BY name");
    first.exec("DELETE FROM harness_run_state; DELETE FROM harness_run_format");
    first.close();
    const fresh = file.open();
    for (const command of [initial, { type: "read", runId }, declare]) {
      await expect(fresh.call(command)).rejects.toMatchObject({ code: "CORRUPT" });
    }
    expect(fresh.rows("SELECT * FROM harness_run_state")).toEqual([]);
    expect(fresh.rows("SELECT * FROM harness_run_format")).toEqual([]);
    expect(fresh.rows("SELECT type, name, sql FROM sqlite_master ORDER BY name")).toEqual(schema);
  });

  it("allows first initialization after its failed transaction rolled back the schema and rows", async () => {
    const file = fixture();
    const first = file.open();
    first.failInitialization();
    await expect(first.call(initial)).rejects.toMatchObject({
      code: "STORAGE",
      cause: expect.objectContaining({ message: "Failure before first initialization committed" }),
    });
    first.close();
    const fresh = file.open();
    expect(
      fresh.rows(
        "SELECT name FROM sqlite_master WHERE name IN ('harness_run_state', 'harness_run_format')",
      ),
    ).toEqual([]);
    await expect(fresh.call({ type: "read", runId })).rejects.toMatchObject({ code: "MISSING" });
    expect(await fresh.call(initial)).toMatchObject({
      action: "recorded",
      snapshot: { invocation: null },
    });
    expect(await fresh.call(declare)).toMatchObject({ action: "launch-once" });
    expect(await fresh.call(declare)).toMatchObject({ action: "observe-only" });
  });

  it.each([
    "CREATE TABLE harness_run_state (slot INTEGER PRIMARY KEY, revision INTEGER, state_json TEXT)",
    "CREATE TABLE harness_run_format (slot INTEGER PRIMARY KEY, version INTEGER)",
    "CREATE VIEW harness_run_state AS SELECT 1 AS slot",
    "CREATE TABLE harness_run_state (slot INTEGER PRIMARY KEY, revision INTEGER, state_json TEXT); CREATE TABLE harness_run_format (slot INTEGER PRIMARY KEY, version INTEGER)",
  ])("preserves and rejects a preexisting empty or incomplete own schema: %s", async (schema) => {
    const file = fixture();
    const first = file.open();
    first.exec(schema);
    const before = first.rows("SELECT type, name, sql FROM sqlite_master ORDER BY name");
    first.close();
    const fresh = file.open();
    for (const command of [{ type: "read", runId }, initial, declare]) {
      await expect(fresh.call(command)).rejects.toMatchObject({ code: "CORRUPT" });
    }
    expect(fresh.rows("SELECT type, name, sql FROM sqlite_master ORDER BY name")).toEqual(before);
  });

  it("preserves the actual Schema and JSON serialization causes of invalid commands", async () => {
    const client = fixture().open();
    await expect(client.call({ type: "read", runId: 42 })).rejects.toMatchObject({
      code: "INVALID",
      cause: { _tag: "SchemaError" },
    });
    await expect(client.call({ type: "read", runId, extra: 1n })).rejects.toMatchObject({
      code: "INVALID",
      cause: expect.any(TypeError),
    });
    expect(client.rows("SELECT name FROM sqlite_master")).toEqual([]);
  });

  it.each([
    {
      query: "UPDATE harness_run_state SET state_json = '{'",
      expected: { cause: expect.any(SyntaxError) },
    },
    {
      query: "UPDATE harness_run_state SET state_json = json_set(state_json, '$.version', 99)",
      expected: { cause: { _tag: "SchemaError" } },
    },
  ])(
    "preserves the actual decode cause of corrupt durable state: $query",
    async ({ query, expected }) => {
      const client = fixture().open();
      await client.call(initial);
      client.exec(query);
      const before = client.raw();
      await expect(client.call({ type: "read", runId })).rejects.toMatchObject({
        code: "CORRUPT",
        ...expected,
      });
      expect(client.raw()).toEqual(before);
    },
  );

  it.each([
    "UPDATE harness_run_state SET state_json = '{'",
    "UPDATE harness_run_state SET state_json = json_set(state_json, '$.version', 2)",
    "UPDATE harness_run_state SET state_json = json_remove(state_json, '$.receipts')",
    "UPDATE harness_run_state SET state_json = json_set(state_json, '$.claims[0].epoch', 2)",
    "UPDATE harness_run_state SET state_json = json_set(state_json, '$.seed.identity.runId', 'other-run')",
    "UPDATE harness_run_state SET state_json = json_set(state_json, '$.invocation.retired', json('true'))",
    "UPDATE harness_run_state SET revision = -1",
    "UPDATE harness_run_format SET version = 99",
    "DELETE FROM harness_run_state",
    "DELETE FROM harness_run_format",
  ])(
    "preserves invalid records and refuses reads, initialization or mutation: %s",
    async (corrupt) => {
      const file = fixture();
      const first = file.open();
      await first.call(initial);
      await first.call(declare);
      first.exec(corrupt);
      const before = first.raw();
      first.close();
      const fresh = file.open();
      for (const command of [{ type: "read", runId }, initial, declare]) {
        await expect(fresh.call(command)).rejects.toMatchObject({ code: "CORRUPT" });
      }
      expect(fresh.raw()).toEqual(before);
    },
  );
});
