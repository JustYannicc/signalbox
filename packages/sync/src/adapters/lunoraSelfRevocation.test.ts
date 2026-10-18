/// <reference types="node" />
// @effect-diagnostics nodeBuiltinImport:off -- Load the emitted mutation in an isolated native module.
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { lunoraTest } from "@lunora/testing";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { defineSchema, defineTable, initLunora, v, type DatabaseReader } from "lunorash/server";
import { describe, expect, it } from "vite-plus/test";

import { emitLunoraFunctions } from "@signalbox/sync/adapters/lunoraFunctions";
import { makeLunoraHome } from "@signalbox/sync/adapters/lunoraHome";
import { defineHome, SyncFailure, type AuthorizationFence } from "@signalbox/sync/definition";
import { table } from "@signalbox/sync/table";

const { internalAction } = initLunora.dataModel().create();
const schema = defineSchema({
  grants: defineTable({ person: v.string(), role: v.string() }).index("__sync_key", ["person"]),
  policy: defineTable({ key: v.string(), epoch: v.number() }).index("__sync_key", ["key"]),
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

async function setup(pauseEncoding = false) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let independentGeneration = 1;
  let installedEpoch = 0;
  let runs = 0;
  const installed: AuthorizationFence[] = [];
  const authorizationCalls: string[] = [];
  const output = Schema.String.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformEffect({
        decode: Effect.succeed,
        encode: (value) =>
          Effect.promise(async () => {
            if (pauseEncoding) {
              entered.resolve();
              await release.promise;
            }
            return value;
          }),
      }),
    ),
  );
  const definition = defineHome(
    {
      actor: Schema.String,
      home: Schema.String,
      tables: {
        grants: table({
          row: Schema.Struct({ person: Schema.String, role: Schema.String }),
          key: ["person"],
          indexes: {},
        }),
        policy: table({
          row: Schema.Struct({ key: Schema.String, epoch: Schema.Int }),
          key: ["key"],
          indexes: {},
        }),
      },
    },
    ({ change }) => ({
      views: {},
      projections: {},
      changes: {
        revoke: change({
          input: Schema.Void,
          output,
          failure: Schema.Never,
          run: (ctx) =>
            Effect.gen(function* () {
              runs += 1;
              const policy = Option.getOrThrow(yield* ctx.tables.policy.get("root"));
              yield* ctx.tables.grants.delete(ctx.actor);
              yield* ctx.tables.policy.patch("root", { epoch: policy.epoch + 1 });
              yield* ctx.requireAuthorizationFence({ scope: ctx.home, epoch: policy.epoch + 1 });
              return "protected receipt output";
            }),
        }),
      },
    }),
  );
  const runtimeFor = (ctx: { readonly db: DatabaseReader }) =>
    makeLunoraHome(
      definition,
      {
        home: "root",
        authorization: {
          authorize: (person, request) =>
            Effect.tryPromise({
              try: async () => {
                authorizationCalls.push(request.kind);
                const grant = await ctx.db.query("grants").first();
                const policy = await ctx.db.query("policy").first();
                if (
                  grant?.person !== person ||
                  grant.role !== "Admin" ||
                  typeof policy?.epoch !== "number"
                )
                  throw new SyncFailure({ reason: "denied" });
                return { localEpoch: policy.epoch, independentGeneration };
              },
              catch: () => new SyncFailure({ reason: "denied" }),
            }),
          isCurrent: (permit) =>
            permit.independentGeneration === independentGeneration &&
            permit.localEpoch >= installedEpoch,
        },
        authorizeIngress: (_ingress: string) => Effect.void,
        completion: {
          install: (fence) =>
            Effect.sync(() => {
              installed.push(fence);
              installedEpoch = Math.max(installedEpoch, fence.epoch);
            }),
        },
      },
      {
        actorKey: String,
        ingressKey: String,
        permitKey: (permit) => String(permit.localEpoch),
        recoveryTarget: "sync:recover",
      },
    );
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "sync-self-revocation-"));
  let closeDatabase = () => {};
  try {
    const packageRoot = NodeURL.fileURLToPath(new URL("../..", import.meta.url));
    const modules = NodePath.join(directory, "node_modules");
    await NodeFSP.mkdir(NodePath.join(modules, "@signalbox"), { recursive: true });
    for (const name of ["effect", "lunorash"])
      await NodeFSP.symlink(
        NodePath.join(packageRoot, "node_modules", name),
        NodePath.join(modules, name),
        "dir",
      );
    await NodeFSP.symlink(packageRoot, NodePath.join(modules, "@signalbox", "sync"), "dir");
    await NodeFSP.writeFile(
      NodePath.join(directory, "binding.mjs"),
      `let resolver;
export const definition = {};
export function bind(ctx) { return resolver(ctx); }
export function configure(value, next) { Object.assign(definition, value); resolver = next; }
`,
    );
    await NodeFSP.writeFile(
      NodePath.join(directory, "server.mjs"),
      'import { initLunora, v } from "lunorash/server"; export { v }; export const { mutation } = initLunora.dataModel().create();\n',
    );
    const emission = emitLunoraFunctions(definition, {
      definitionImport: "./binding.mjs",
      bindingImport: "./binding.mjs",
      serverImport: "./server.mjs",
    });
    await NodeFSP.writeFile(
      NodePath.join(directory, "functions.mjs"),
      NodeModule.stripTypeScriptTypes(
        `${emission.source}\nexport { configure } from "./binding.mjs";\n`,
      ),
    );
    const functions = await import(
      /* @vite-ignore */ NodeURL.pathToFileURL(NodePath.join(directory, "functions.mjs")).href
    );
    functions.configure(definition, (ctx: { readonly db: DatabaseReader }) => ({
      runtime: runtimeFor(ctx),
      actor: "admin",
    }));
    const recovery = internalAction
      .input({ home: v.any(), after: v.union(v.string(), v.null()) })
      .action(async (): Promise<{ readonly _tag: "Drained" | "Pending" }> => {
        const runtime = await db.query((ctx) => runtimeFor(ctx));
        return runtime.recoverFences({
          pending: (after) => db.query((ctx) => runtime.pendingFences({ ctx, after })),
          scheduleNext: (after) =>
            db.mutation((ctx) => runtime.scheduleFenceRecovery({ ctx, after })),
          acknowledge: (receipt) =>
            db.mutation((ctx) => runtime.acknowledgeFence({ ctx, receipt })),
        });
      });
    const db = lunoraTest(schema, {
      functions: { "sync:recover": recovery, "sync:change_revoke": functions.change_revoke },
    });
    closeDatabase = () => db.close();
    await db.mutation(async (ctx) => {
      await ctx.db.insert("grants", { person: "admin", role: "Admin" });
      await ctx.db.insert("policy", { key: "root", epoch: 1 });
    });
    return {
      db,
      installed,
      authorizationCalls,
      entered,
      release,
      revokeIndependently: () => {
        independentGeneration += 1;
      },
      runs: () => runs,
      invoke: () =>
        db.action((ctx) =>
          ctx.runMutation(functions.change_revoke, {
            input: { defined: false },
            operationKey: "self-revoke",
          }),
        ),
      inspect: () =>
        db.query(async (ctx) => ({
          grants: await ctx.db.query("grants").collect(),
          policy: await ctx.db.query("policy").first(),
          receipts: await ctx.db.query("syncReceipts").collect(),
        })),
      close: async () => {
        db.close();
        await NodeFSP.rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    closeDatabase();
    await NodeFSP.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

describe("generated self-revoking policy mutations", () => {
  it("commits outputless Pending and durable recovery, then denies replay before and after the fence", async () => {
    const t = await setup();
    try {
      expect(await t.invoke()).toEqual({ _tag: "Pending", operationKey: "self-revoke" });
      const committed = await t.inspect();
      expect(committed.grants).toEqual([]);
      expect(committed.policy).toMatchObject({ epoch: 2 });
      expect(committed.receipts).toHaveLength(1);
      expect(committed.receipts[0]).toMatchObject({
        pending: true,
        fences: [{ scope: "root", epoch: 2 }],
      });
      expect(t.db.scheduler.list()).toHaveLength(1);
      expect(t.authorizationCalls).toEqual(["change"]);
      await expect(t.invoke()).rejects.toMatchObject({ code: "FORBIDDEN" });
      await t.db.scheduler.runPending();
      expect(t.installed).toEqual([{ scope: "root", epoch: 2 }]);
      expect((await t.inspect()).receipts[0]).toMatchObject({ pending: false });
      await expect(t.invoke()).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(t.runs()).toBe(1);
      expect((await t.inspect()).receipts).toHaveLength(1);
    } finally {
      await t.close();
    }
  });

  it("rolls back a fenced self-revocation when independent authority changes during output encoding", async () => {
    const t = await setup(true);
    try {
      const mutation = t.invoke();
      const outcome = mutation.then(
        (value) => ({ _tag: "Success" as const, value }),
        (error: unknown) => ({ _tag: "Failure" as const, error }),
      );
      await Promise.race([
        t.entered.promise,
        outcome.then((result) => {
          throw new Error("Mutation finished before reaching the output encoder", {
            cause: result._tag === "Failure" ? result.error : result.value,
          });
        }),
      ]);
      t.revokeIndependently();
      t.release.resolve();
      expect(await outcome).toMatchObject({ _tag: "Failure", error: { code: "FORBIDDEN" } });
      const rolledBack = await t.inspect();
      expect(rolledBack.grants).toMatchObject([{ person: "admin", role: "Admin" }]);
      expect(rolledBack.policy).toMatchObject({ epoch: 1 });
      expect(rolledBack.receipts).toEqual([]);
      expect(t.db.scheduler.list()).toEqual([]);
      expect(t.installed).toEqual([]);
    } finally {
      t.release.resolve();
      await t.close();
    }
  });
});
