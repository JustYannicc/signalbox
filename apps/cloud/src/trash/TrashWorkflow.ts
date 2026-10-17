import type { SignalboxTrashError } from "@t3tools/contracts/signalboxTrash";
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

/** The cloud keeps Trash and restore; irreversible cleanup is intentionally unavailable. */
export const layerPreview = Layer.succeed(
  TrashWorkflow,
  TrashWorkflow.of({
    enabled: false,
    start: () => Effect.void,
  }),
);
