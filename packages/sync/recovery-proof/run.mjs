import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { lunoraTest } from "@lunora/testing";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { createShardClient } from "lunorash/runtime";
import { defineSchema, defineTable, v } from "lunorash/server";
import { defineHome, SyncFailure } from "@signalbox/sync/definition";
import { table } from "@signalbox/sync/table";
import { makeLunoraHome } from "@signalbox/sync/adapters/lunoraHome";
import { emitLunoraRecovery } from "@signalbox/sync/adapters/lunoraRecovery";

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "sync-recovery-"));
const home = Schema.Struct({ owner: Schema.String });
const emission = emitLunoraRecovery(home, {
  bindingImport: "./binding.mjs",
  moduleName: "recovery",
  serverImport: "./server.mjs",
  internalImport: "./internal.mjs",
});
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
    home,
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
let harness;
let failInstall = true;
const installed = [];
const routed = [];
let runtime;
try {
  await NodeFSP.mkdir(NodePath.join(directory, "node_modules", "@signalbox"), { recursive: true });
  await NodeFSP.symlink(
    root,
    NodePath.join(directory, "node_modules", "@signalbox", "sync"),
    "dir",
  );
  await NodeFSP.writeFile(NodePath.join(directory, "recovery.mjs"), emission.source);
  await NodeFSP.writeFile(
    NodePath.join(directory, "server.mjs"),
    `import { initLunora, v } from ${JSON.stringify(import.meta.resolve("lunorash/server"))};\nexport { v }; export const { internalAction, internalMutation, internalQuery } = initLunora.dataModel().create();\n`,
  );
  await NodeFSP.writeFile(
    NodePath.join(directory, "internal.mjs"),
    `export const internal = { recovery: ${JSON.stringify(Object.fromEntries(Object.values(emission.functions).map((name) => [name, { __lunoraRef: `recovery:${name}` }])))} };\n`,
  );
  await NodeFSP.writeFile(
    NodePath.join(directory, "binding.mjs"),
    "let resolver; export function configure(value) { resolver = value; } export const bindRecovery = (ctx, home) => resolver(ctx, home);\n",
  );
  const functions = await import(
    NodeURL.pathToFileURL(NodePath.join(directory, "recovery.mjs")).href
  );
  harness = lunoraTest(schema, {
    functions: Object.fromEntries(
      Object.entries(functions).map(([name, value]) => [`recovery:${name}`, value]),
    ),
  });
  const client = createShardClient({
    idFromName: (name) => ({ toString: () => name }),
    get: (id) => ({
      fetch: async (request) => {
        NodeAssert.equal(id.toString(), "owner-home");
        NodeAssert.equal(request.headers.get("x-lunora-system"), "1");
        const body = await request.json();
        routed.push(body.functionPath);
        const name = body.functionPath.split(":")[1];
        const result = await harness.action((ctx) =>
          name === emission.functions.pending
            ? ctx.runQuery(functions[name], body.args)
            : ctx.runMutation(functions[name], body.args),
        );
        return Response.json({ result });
      },
    }),
  }).forShard("owner-home");
  runtime = makeLunoraHome(
    definition,
    {
      home: { owner: "one" },
      authorization: { authorize: () => Effect.succeed(true), isCurrent: () => true },
      authorizeIngress: () => Effect.void,
      completion: {
        install: (fence) =>
          Effect.suspend(() => {
            if (failInstall) return Effect.fail(new SyncFailure({ reason: "unavailable" }));
            installed.push(fence);
            return Effect.void;
          }),
      },
    },
    {
      actorKey: String,
      ingressKey: String,
      permitKey: String,
      recoveryTarget: emission.recoveryTarget,
    },
  );
  const binding = await import(NodeURL.pathToFileURL(NodePath.join(directory, "binding.mjs")).href);
  binding.configure((_ctx, requestedHome) => {
    NodeAssert.deepEqual(requestedHome, { owner: "one" });
    return { runtime, client };
  });
  const apply = () =>
    harness.mutation((ctx) =>
      runtime.change("write")({ ctx, args: { actor: "person", input: 1, operationKey: "one" } }),
    );
  await NodeAssert.rejects(
    harness.mutation(async (ctx) => {
      await runtime.change("write")({
        ctx,
        args: { actor: "person", input: 1, operationKey: "rollback" },
      });
      throw new Error("rollback");
    }),
    /rollback/,
  );
  NodeAssert.equal(harness.scheduler.list().length, 0);
  NodeAssert.equal((await harness.query((ctx) => ctx.db.query("rows").collect())).length, 0);
  NodeAssert.deepEqual(await apply(), { _tag: "Pending", operationKey: "one" });
  NodeAssert.equal(installed.length, 0);
  NodeAssert.equal(harness.scheduler.list().length, 1);
  for (let attempt = 0; attempt < 7; attempt += 1) {
    await harness.scheduler.runPending();
    NodeAssert.equal(harness.scheduler.list().length, 1);
  }
  NodeAssert.deepEqual(await apply(), { _tag: "Pending", operationKey: "one" });
  failInstall = false;
  await harness.scheduler.runPending();
  NodeAssert.equal(installed.length, 1);
  await harness.scheduler.runPending();
  NodeAssert.equal(harness.scheduler.list().length, 0);
  NodeAssert.equal((await apply())._tag, "Committed");
  NodeAssert.equal((await harness.query((ctx) => ctx.db.query("rows").collect())).length, 1);
  NodeAssert.ok(routed.includes(`recovery:${emission.functions.acknowledge}`));
  console.log(
    JSON.stringify({
      functions: Object.keys(functions).length,
      postCommitInstallations: installed.length,
      rows: 1,
      recoveryRouting: "native-system-shard-client",
      failedAttempts: 7,
      pendingJobs: 0,
    }),
  );
} finally {
  harness?.close();
  await NodeFSP.rm(directory, { recursive: true, force: true });
}
