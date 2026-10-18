import * as Cause from "effect/Cause";
import * as Atom from "effect/reactivity/Atom";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Stream from "effect/Stream";
import type { SyncCursor, ViewFrame } from "./definition.ts";
import type {
  Failure,
  HomeOperations,
  Input,
  Output,
  SyncFailure,
  SyncViewSource,
} from "./definition.ts";

export type SyncViewState<A> =
  | { readonly _tag: "Pending" }
  | {
      readonly _tag: "Value";
      readonly frame: "Snapshot" | "Update" | "Reset";
      readonly value: A;
      readonly cursor: SyncCursor;
    }
  | { readonly _tag: "Revoked" };

const pending = { _tag: "Pending" } as const;

function viewState<A>(frame: ViewFrame<A>): SyncViewState<A> {
  if (frame._tag === "Revoked") return frame;
  return {
    _tag: "Value",
    frame: frame._tag,
    value: frame.value,
    cursor: frame.cursor,
  };
}

/** One lazily subscribed, replacement-only view atom. Unmounting it tears down the subscription. */
export function makeSyncViewAtom<
  Views extends HomeOperations["views"],
  K extends keyof Views & string,
>(
  client: SyncViewSource<Views>,
  operation: K,
  input: Input<Views[K]>,
  resume?: SyncCursor,
): Atom.Atom<
  AsyncResult.AsyncResult<
    SyncViewState<Output<Views[K]>>,
    Failure<Views[K]> | SyncFailure | Cause.NoSuchElementError
  >
> {
  return Atom.make(client.view(operation, input, resume).pipe(Stream.map(viewState)), {
    initialValue: pending,
  }).pipe(Atom.withLabel(`sync-view:${operation}`));
}
