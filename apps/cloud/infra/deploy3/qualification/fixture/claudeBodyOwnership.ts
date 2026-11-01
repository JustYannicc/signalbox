export type ClaudeIncomingRequestBodyLifecycle =
  | "not-owned"
  | "owned"
  | "consumed"
  | "delegated-unverified"
  | "cancelled"
  | "cancel-requested"
  | "cancel-failed";

type CancellationResult =
  | { readonly lifecycle: "not-owned" | "consumed" | "cancelled" | "cancel-requested" }
  | { readonly lifecycle: "cancel-failed"; readonly cause: unknown };

/** Requests cancellation without waiting for a tee's other branch to settle. */
export async function cancelClaudeBodyQuick(
  body: ReadableStream<Uint8Array> | null,
): Promise<CancellationResult> {
  if (!body) return { lifecycle: "not-owned" };
  try {
    let result: CancellationResult = { lifecycle: "cancel-requested" };
    const reader = body.getReader();
    const cancelled = reader.cancel();
    void cancelled.then(
      () => {
        result = { lifecycle: "cancelled" };
      },
      (cause: unknown) => {
        result = { lifecycle: "cancel-failed", cause };
      },
    );
    reader.releaseLock();
    await Promise.resolve();
    await Promise.resolve();
    return result;
  } catch (cause) {
    return { lifecycle: "cancel-failed", cause };
  }
}

/** Cancels the incoming branch without waiting for a tee's other branch to settle. */
export async function cancelClaudeIncomingRequestBody(
  request: Request,
): Promise<CancellationResult> {
  const body = request.body;
  if (!body) return { lifecycle: "not-owned" };
  if (request.bodyUsed) return { lifecycle: "consumed" };
  return await cancelClaudeBodyQuick(body);
}
