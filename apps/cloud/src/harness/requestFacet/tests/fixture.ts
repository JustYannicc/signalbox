// @effect-diagnostics nodeBuiltinImport:off - the fixture exercises the public store on disposable SQLite.
import * as NodeSqlite from "node:sqlite";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import {
  createHarnessRunStore,
  type HarnessRunArtifact,
  type HarnessRunDatabase,
  type HarnessRequestPublisher,
} from "../../HarnessRunStore.ts";
import {
  createHarnessRequestFacet,
  HarnessRequestFacetError,
  type HarnessRequestFacetOptions,
} from "../../HarnessRequestFacet.ts";

export const runId = "request-facet-run";
export const controlKey = "controller-capability-".repeat(3);
export const supervisor = {
  epoch: 1,
  claimId: "supervisor-one",
  supervisorKey: "supervisor-capability-".repeat(3),
};
export const publisher = (facetNonce = "facet-one", generation = 1): HarnessRequestPublisher => ({
  generation,
  facetNonce,
  publisherKey: `publisher-${generation}-capability-`.repeat(3),
});

export const requestFacetFixture = Effect.gen(function* () {
  const sqlite = yield* Effect.acquireRelease(
    Effect.sync(() => new NodeSqlite.DatabaseSync(":memory:")),
    (database) => Effect.sync(() => database.close()),
  );
  const database: HarnessRunDatabase = {
    sql: {
      exec(query, ...bindings) {
        const statement = sqlite.prepare(query);
        return statement.columns().length
          ? statement.all(...bindings)
          : (statement.run(...bindings), []);
      },
    },
    transactionSync(work) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const result = work();
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const artifacts = new Map<string, { reference: HarnessRunArtifact; bytes: Uint8Array }>();
  const reference = (id: string) => {
    const bytes = new TextEncoder().encode(id);
    const result = {
      id,
      bytes: bytes.byteLength,
      sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    };
    artifacts.set(id, { reference: result, bytes });
    return result;
  };
  const checkpoint = (id: string) => ({
    native: reference(`${id}-native`),
    filesystem: reference(`${id}-filesystem`),
  });
  const initial = checkpoint("initial");
  const call = (command: unknown) => createHarnessRunStore(database, runId).execute(command);
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const store = { execute: (command: unknown) => runPromise(call(command)) };
  yield* call({
    type: "initialize",
    seed: {
      identity: {
        runId,
        hostId: "host",
        threadId: "thread",
        logicalTurnId: "run",
        filesystemId: "fs",
      },
      locator: reference("locator"),
      config: reference("config"),
      artifacts: [reference("release")],
    },
    controlKey,
    supervisorKey: supervisor.supervisorKey,
    claimId: supervisor.claimId,
    requestId: "initialize",
  });
  yield* call({ type: "request.mode", runId, controlKey, requestId: "mode", checkpoint: initial });
  const bind = (owner: HarnessRequestPublisher) =>
    call({
      type: "request.replaceFacet",
      runId,
      controlKey,
      expectedGeneration: owner.generation - 1,
      operationId: `replace-${owner.generation}`,
      facetNonce: owner.facetNonce,
      publisherKey: owner.publisherKey,
    });
  yield* bind(publisher());
  const offer = (requestId: string) =>
    call({
      type: "request.offer",
      runId,
      supervisor,
      request: { requestId, input: reference(`input-${requestId}`) },
    });
  const options: Omit<HarnessRequestFacetOptions, "open"> = {
    runId,
    facetNonce: publisher().facetNonce,
    store,
    verify: (candidate) =>
      Effect.try({
        try: () => {
          const existing = artifacts.get(candidate.id);
          if (
            !existing ||
            candidate.bytes !== existing.bytes.byteLength ||
            candidate.sha256 !==
              NodeCrypto.createHash("sha256").update(existing.bytes).digest("hex")
          )
            throw new Error("Artifact bytes do not match");
        },
        catch: (cause) => new HarnessRequestFacetError("Artifact verification failed", { cause }),
      }),
  };
  return {
    initial,
    reference,
    checkpoint,
    call,
    bind,
    offer,
    options,
    create: (
      open: HarnessRequestFacetOptions["open"],
      overrides?: Partial<HarnessRequestFacetOptions>,
    ) => createHarnessRequestFacet({ ...options, open, ...overrides }),
  };
});
