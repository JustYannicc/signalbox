import type { DeviceSession } from "@t3tools/contracts";

import { randomUUID } from "~/lib/utils";

export type DeviceOpenSurfaceResult<E> =
  | { readonly _tag: "Success"; readonly value: DeviceSession }
  | { readonly _tag: "Failure"; readonly cause: E };

export type DeviceOpenSurfaceSettlement<E> =
  | { readonly _tag: "Settled"; readonly result: DeviceOpenSurfaceResult<E> }
  | { readonly _tag: "Cancelled" };

export const settleDeviceOpenForSurface = async <E>(input: {
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
  readonly open: (signal: AbortSignal, requestId: string) => Promise<DeviceOpenSurfaceResult<E>>;
  readonly cancel: (requestId: string) => Promise<unknown>;
  readonly release: (session: DeviceSession) => Promise<unknown>;
  readonly accept: (result: DeviceOpenSurfaceResult<E>) => void;
}): Promise<DeviceOpenSurfaceSettlement<E>> => {
  const requestId = randomUUID();
  let cancellation: Promise<unknown> | undefined;
  const cancel = () => (cancellation ??= input.cancel(requestId));
  const cancelQuietly = async () => {
    try {
      await cancel();
    } catch {
      // A late successful open still gets released below when its response arrives.
    }
  };
  const onAbort = () => void cancelQuietly();
  input.signal.addEventListener("abort", onAbort, { once: true });
  if (input.signal.aborted || !input.isCurrent()) {
    await cancelQuietly();
    input.signal.removeEventListener("abort", onAbort);
    return { _tag: "Cancelled" };
  }

  try {
    let result: DeviceOpenSurfaceResult<E>;
    try {
      result = await input.open(input.signal, requestId);
    } catch (error) {
      if (input.signal.aborted || !input.isCurrent()) {
        await cancelQuietly();
        return { _tag: "Cancelled" };
      }
      throw error;
    }
    if (input.signal.aborted || !input.isCurrent()) {
      await cancelQuietly();
      if (result._tag === "Success") await input.release(result.value);
      return { _tag: "Cancelled" };
    }
    input.accept(result);
    return { _tag: "Settled", result };
  } finally {
    input.signal.removeEventListener("abort", onAbort);
  }
};
