import { DurableObject } from "cloudflare:workers";
import {
  beginDeferredSchedules,
  defineSchema,
  defineTable,
  v,
  withDeferredSchedules,
} from "lunorash/server";
import { createInProcessRuntime } from "@lunora/server/in-process";
import {
  forgetScheduleOutbox,
  readDueScheduleOutbox,
  recordScheduleOutbox,
} from "@lunora/shard-engine";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { defineHome } from "@signalbox/sync/definition";
import { table } from "@signalbox/sync/table";
import { makeLunoraHome } from "@signalbox/sync/adapters/lunoraHome";

const schema = defineSchema({
  rows: defineTable({ key: v.string(), value: v.number() }).index("__sync_key", ["key"]),
  syncReceipts: defineTable({
    scope: v.string(),
    operationKey: v.string(),
    payload: v.string(),
    value: v.string(),
    fences: v.array(v.object({ scope: v.string(), epoch: v.number() })),
    pending: v.boolean(),
  })
    .index("__sync_key", ["scope", "operationKey"])
    .index("pending", ["pending"]),
});
const definition = defineHome(
  {
    actor: Schema.String,
    home: Schema.String,
    tables: {
      rows: table({
        row: Schema.Struct({ key: Schema.String, value: Schema.Number }),
        key: ["key"],
        indexes: {},
      }),
    },
  },
  ({ change }) => ({
    views: {},
    projections: {},
    changes: {
      write: change({
        input: Schema.Number,
        output: Schema.Void,
        failure: Schema.Never,
        run: (ctx, value) =>
          Effect.gen(function* () {
            yield* ctx.tables.rows.insert({ key: "one", value });
            yield* ctx.requireAuthorizationFence({ scope: "owner", epoch: 1 });
          }),
      }),
    },
  }),
);

export class CustodyProof extends DurableObject {
  async fetch(request: Request) {
    const body = (await request.json()) as {
      operation: "apply" | "rollback" | "inspect" | "transfer";
    };
    const sql = this.ctx.storage.sql;
    const scheduler = withDeferredSchedules(
      {
        runAfter: async () => {
          throw new Error("scheduler unavailable");
        },
        runAt: async () => {
          throw new Error("scheduler unavailable");
        },
      },
      {
        admit: () => undefined,
        record: (id, envelope) => recordScheduleOutbox(sql, id, JSON.stringify(envelope), 0),
        forget: (id) => forgetScheduleOutbox(sql, id),
        wake: () => {},
      },
    );
    const engine = createInProcessRuntime(schema, { sql, scheduler });
    const db = engine.createWriters({ userId: null, claims: null }).rawDatabase;
    const runtime = makeLunoraHome(
      definition,
      {
        home: "home",
        authorization: { authorize: () => Effect.succeed(true), isCurrent: () => true },
        authorizeIngress: () => Effect.void,
        completion: { install: () => Effect.void },
      },
      {
        actorKey: String,
        ingressKey: String,
        permitKey: String,
        recoveryTarget: "recovery:sync_recoverFences",
      },
    );
    if (body.operation === "apply" || body.operation === "rollback") {
      const settle = beginDeferredSchedules({ scheduler });
      try {
        await this.ctx.storage.transaction(async () => {
          await runtime.change("write")({
            ctx: { db, scheduler },
            args: { actor: "person", input: 1, operationKey: "operation" },
          });
          if (body.operation === "rollback") throw new Error("rollback");
        });
        try {
          await settle(true);
        } catch {
          /* Custody remains until native retry transfers it. */
        }
      } catch {
        await settle(false);
      }
    }
    const custody = readDueScheduleOutbox(sql, Number.MAX_SAFE_INTEGER, 100);
    if (body.operation === "transfer") {
      for (const entry of custody) {
        const envelope = JSON.parse(entry.envelopeJson);
        // This local scheduler stand-in persists acceptance, then releases native custody.
        await this.ctx.storage.put(`accepted:${entry.id}`, envelope);
        forgetScheduleOutbox(sql, entry.id);
      }
    }
    return Response.json({
      rows: (await db.query("rows").collect()).length,
      receipts: (await db.query("syncReceipts").collect()).length,
      custody: readDueScheduleOutbox(sql, Number.MAX_SAFE_INTEGER, 100).map((entry) => ({
        id: entry.id,
        envelopeJson: entry.envelopeJson,
      })),
      accepted: (await this.ctx.storage.list({ prefix: "accepted:" })).size,
    });
  }
}

export default {
  fetch(request: Request, env: { CUSTODY: DurableObjectNamespace }) {
    return env.CUSTODY.get(env.CUSTODY.idFromName("home")).fetch(request);
  },
};
