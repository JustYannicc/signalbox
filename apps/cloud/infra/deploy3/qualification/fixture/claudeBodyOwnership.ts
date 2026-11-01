export type ClaudeIncomingRequestBodyLifecycle =
  | "not-owned"
  | "owned"
  | "consumed"
  | "delegated-unverified"
  | "cancelled"
  | "cancel-requested"
  | "cancel-failed";

type BodyCancellationLifecycle = "cancelled" | "cancel-requested" | "cancel-failed";

/** Requests cancellation without waiting for a tee's other branch to settle. */
export function cancelClaudeBodyQuick(body: null): Promise<"not-owned">;
export function cancelClaudeBodyQuick(
  body: ReadableStream<Uint8Array>,
): Promise<BodyCancellationLifecycle>;
export function cancelClaudeBodyQuick(
  body: ReadableStream<Uint8Array> | null,
): Promise<BodyCancellationLifecycle | "not-owned">;
export async function cancelClaudeBodyQuick(
  body: ReadableStream<Uint8Array> | null,
): Promise<BodyCancellationLifecycle | "not-owned"> {
  if (!body) return "not-owned";
  try {
    let lifecycle: BodyCancellationLifecycle = "cancel-requested";
    const reader = body.getReader();
    const cancelled = reader.cancel();
    void cancelled.then(
      () => {
        lifecycle = "cancelled";
      },
      () => {
        lifecycle = "cancel-failed";
      },
    );
    reader.releaseLock();
    await Promise.resolve();
    return lifecycle;
  } catch {
    return "cancel-failed";
  }
}

/** Cancels the incoming branch without waiting for a tee's other branch to settle. */
export async function cancelClaudeIncomingRequestBody(
  request: Request,
): Promise<ClaudeIncomingRequestBodyLifecycle> {
  const body = request.body;
  if (!body) return "not-owned";
  if (request.bodyUsed) return "consumed";
  return await cancelClaudeBodyQuick(body);
}
