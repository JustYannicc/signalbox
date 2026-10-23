import {
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2SubscribeThreadInput,
  type OrchestrationV2ThreadLaunchInput,
  ThreadId,
} from "@t3tools/contracts";
import { PERSONAL_POOL_ID } from "@t3tools/contracts/accountHub";
import { RpcStub } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";

import { HarnessError } from "./harness/Harness.ts";
import { poolKindOfInstance } from "./models/ModelRouting.ts";
import { handleFor as poolHandleFor } from "./pool/PoolDirectory.ts";
import { LocalModelTransport, type LocalPoolObjectApi } from "./pool/LocalPoolObject.ts";
import type { LocalClaudeThreadObjectApi } from "./thread/LocalClaudeThreadObject.ts";
import { onPool } from "./thread/turnPool.ts";
import { wire } from "./thread/threadWire.ts";
import type { LocalUserObjectApi } from "./user/LocalUserObject.ts";
import { userThreadWire } from "./user/ThreadOperations.ts";

export interface LocalDomainObjectNamespace<Api> {
  readonly idFromName: (name: string) => DurableObjectId;
  readonly get: (id: DurableObjectId) => Api;
}

export interface WorkerdLocalClaudeThreadMachine {
  readonly type: "workerd";
  readonly threadId: string;
  readonly objects: {
    readonly user: LocalDomainObjectNamespace<LocalUserObjectApi>;
    readonly pool: LocalDomainObjectNamespace<LocalPoolObjectApi>;
    readonly thread: LocalDomainObjectNamespace<LocalClaudeThreadObjectApi>;
  };
}

export interface WorkerdLocalClaudeThreadHostOptions {
  readonly modelSelection: ModelSelection;
  readonly modelTransport: (request: Request) => Promise<Response>;
  readonly machine: WorkerdLocalClaudeThreadMachine;
}

const failed = (operation: "open" | "events", message: string, cause?: unknown) =>
  new HarnessError({ operation, message, ...(cause === undefined ? {} : { cause }) });

const call = <A>(message: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => failed("events", message, cause) });

const decodeLine = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

/** Places each domain in its own object; all traffic uses the product's wire contracts. */
export const createWorkerdLocalClaudeThreadHost = (options: WorkerdLocalClaudeThreadHostOptions) =>
  Effect.gen(function* () {
    if (poolKindOfInstance(options.modelSelection.instanceId) !== "claude")
      return yield* failed("open", "The local Claude host needs a Claude model transport.");
    const { objects, threadId: id } = options.machine;
    const threadId = ThreadId.make(id);
    const user = objects.user.get(objects.user.idFromName(`local:${id}:user`));
    const pool = objects.pool.get(objects.pool.idFromName(`local:${id}:pool`));
    const thread = objects.thread.get(objects.thread.idFromName(id));
    let closed = false;
    const dispose = Effect.suspend(() => {
      if (closed) return Effect.void;
      closed = true;
      return call("The local domain could not close.", async () => {
        const results = await Promise.allSettled([
          thread.dispose(),
          user.dispose(),
          pool.dispose(),
        ]);
        const first = results.find((result) => result.status === "rejected");
        if (first?.status === "rejected") throw first.reason;
      });
    });
    yield* Effect.addFinalizer(() => dispose.pipe(Effect.orDie));
    return yield* Effect.gen(function* () {
      const owner = yield* call("The local user could not be provisioned.", () =>
        user.initialize(),
      );
      yield* call("The local pool could not be configured.", async () => {
        using transport = new RpcStub(new LocalModelTransport(options.modelTransport));
        await pool.configure(owner.id, transport, options.modelSelection);
      });
      const usercap = yield* Effect.acquireRelease(
        call("The local user capability is unavailable.", () => user.capability()),
        (capability) => Effect.sync(() => capability[Symbol.dispose]()),
      );
      const poolcap = yield* Effect.acquireRelease(
        call("The local pool capability is unavailable.", () => pool.capability()),
        (capability) => Effect.sync(() => capability[Symbol.dispose]()),
      );
      const threadcap = yield* Effect.acquireRelease(
        call("The local thread capability is unavailable.", () => thread.capability()),
        (capability) => Effect.sync(() => capability[Symbol.dispose]()),
      );
      yield* call("The local user could not be configured.", () =>
        user.configure(
          { threadId: id, modelSelection: options.modelSelection },
          poolcap,
          threadcap,
        ),
      );
      yield* call("The model transport could not be registered.", () => pool.register());
      yield* call("The local catalog could not be refreshed.", () => user.refreshPools());
      yield* call("The local thread could not be configured.", () =>
        thread.configure(
          { threadId: id, owner, modelSelection: options.modelSelection },
          usercap,
          poolcap,
        ),
      );
      const actor = call("The local owner is unavailable.", () => user.getActor());
      const subscribe = (input: Omit<OrchestrationV2SubscribeThreadInput, "threadId"> = {}) =>
        Stream.unwrap(
          call("The local thread subscription failed.", () =>
            user.subscribe(wire.subscribeInput.encode({ ...input, threadId })),
          ).pipe(
            Effect.map((body) =>
              Stream.fromReadableStream({
                evaluate: () => body,
                onError: (cause) => failed("events", "The local thread stream failed.", cause),
              }).pipe(
                Stream.decodeText(),
                Stream.splitLines,
                Stream.filter((line) => line.length > 0),
                Stream.map((line) => wire.batch.decode(decodeLine(line))),
              ),
            ),
          ),
        );
      return {
        owner,
        actor,
        modelSelection: onPool(options.modelSelection, PERSONAL_POOL_ID),
        domain: {
          catalog: call("The local catalog is unavailable.", () => user.catalog()),
          home: call("The local home is unavailable.", () => user.home()),
          refreshPools: call("The local pools could not be refreshed.", () => user.refreshPools()),
        },
        pool: poolHandleFor(pool),
        launch: (input: OrchestrationV2ThreadLaunchInput) =>
          call("The local thread launch failed.", () =>
            user.launch(userThreadWire.launchInput.encode(input)),
          ).pipe(Effect.map(wire.launchResult.decode)),
        dispatch: (command: OrchestrationV2Command) =>
          call("The local thread command failed.", () =>
            user.dispatch(userThreadWire.command.encode(command)),
          ),
        snapshot: () =>
          call("The local thread snapshot failed.", () => user.snapshot(id)).pipe(
            Effect.map(wire.snapshot.decode),
          ),
        subscribe,
        failure: call("The local thread host failed.", () => thread.failure()),
        dispose,
      };
    }).pipe(Effect.onError(() => dispose.pipe(Effect.orDie)));
  });
