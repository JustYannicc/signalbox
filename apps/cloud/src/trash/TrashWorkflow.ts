import { SignalboxTrashError } from "@t3tools/contracts/signalboxTrash";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface TrashProgress {
  readonly done: boolean;
  readonly nextAt: number;
}

export class TrashWorkflow extends Context.Service<
  TrashWorkflow,
  {
    readonly enabled: boolean;
    readonly start: (userId: string, trashId: string) => Effect.Effect<void, SignalboxTrashError>;
  }
>()("@signalbox/cloud/trash/TrashWorkflow") {}

/** Shared with session expiry and cron alarms; a cut-off launch remains in the SQL outbox. */
export class TrashAlarm extends Context.Service<
  TrashAlarm,
  {
    readonly armBy: (at: number) => Effect.Effect<void>;
  }
>()("@signalbox/cloud/trash/TrashAlarm") {}

export const layerWorkflows = (binding: Workflow | undefined, enabled: boolean) =>
  Layer.succeed(
    TrashWorkflow,
    TrashWorkflow.of({
      enabled,
      start: (userId, trashId) =>
        Effect.tryPromise({
          try: async () => {
            if (binding === undefined) throw new Error("No trash Workflow binding is configured.");
            const id = `trash-${trashId}`;
            try {
              await binding.create({ id, params: { userId, trashId } });
            } catch (cause) {
              // Only an existing instance proves the launch landed before its response was lost.
              try {
                const instance = await binding.get(id);
                const { status } = await instance.status();
                if (status === "errored" || status === "terminated") await instance.restart();
              } catch {
                throw cause;
              }
            }
          },
          catch: () =>
            new SignalboxTrashError({ message: "Could not start trash cleanup. It will retry." }),
        }),
    }),
  );
