export type PullRequestWriteAttemptRecord = {
  readonly requestKey: string;
  readonly operationId: string;
  readonly headSha?: string | undefined;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

export function preparePullRequestWriteAttempt<T extends object>(
  previous: PullRequestWriteAttemptRecord | undefined,
  request: T,
  reviewedHeadSha: string | undefined,
  createOperationId: () => string,
  scope?: unknown,
) {
  const requestKey = JSON.stringify(canonicalize([request, reviewedHeadSha, scope])) ?? "undefined";
  const attempt =
    previous?.requestKey === requestKey
      ? previous
      : {
          requestKey,
          operationId: createOperationId(),
          ...(reviewedHeadSha === undefined ? {} : { headSha: reviewedHeadSha }),
        };
  return {
    attempt,
    input: {
      ...request,
      operationId: attempt.operationId,
      ...(attempt.headSha === undefined ? {} : { headSha: attempt.headSha }),
    } as T & { readonly operationId: string; readonly headSha?: string },
  };
}
