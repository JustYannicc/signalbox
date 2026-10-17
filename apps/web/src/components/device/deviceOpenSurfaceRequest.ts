import type { DeviceSession } from "@t3tools/contracts";

export type DeviceOpenSurfaceResult<E> =
  | { readonly _tag: "Success"; readonly value: DeviceSession }
  | { readonly _tag: "Failure"; readonly cause: E };

export type DeviceOpenSurfaceSettlement<E> =
  | { readonly _tag: "Settled"; readonly result: DeviceOpenSurfaceResult<E> }
  | { readonly _tag: "Cancelled" };

export const settleDeviceOpenForSurface = async <E>(input: {
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
  readonly open: (signal: AbortSignal) => Promise<DeviceOpenSurfaceResult<E>>;
  readonly release: (session: DeviceSession) => Promise<unknown>;
  readonly accept: (result: DeviceOpenSurfaceResult<E>) => void;
}): Promise<DeviceOpenSurfaceSettlement<E>> => {
  const result = await input.open(input.signal);
  if (input.signal.aborted || !input.isCurrent()) {
    if (result._tag === "Success") await input.release(result.value);
    return { _tag: "Cancelled" };
  }
  input.accept(result);
  return { _tag: "Settled", result };
};
