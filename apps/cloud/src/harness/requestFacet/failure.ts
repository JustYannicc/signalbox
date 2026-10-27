export interface HarnessRequestFacetFailureCause {
  readonly name: string;
  readonly message: string;
  readonly _tag?: string;
  readonly operation?: string;
  readonly code?: string;
  readonly kind?: string;
  readonly recoverable?: boolean;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
  readonly stack?: string;
}

export type HarnessRequestFacetFailure = readonly HarnessRequestFacetFailureCause[];

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

function scalarDetails(
  value: unknown,
): Readonly<Record<string, string | number | boolean>> | undefined {
  const input = record(value);
  if (input === undefined) return undefined;
  const details: Record<string, string | number | boolean> = {};
  for (const [key, detail] of Object.entries(input)) {
    if (typeof detail === "string" || typeof detail === "boolean") details[key] = detail;
    else if (typeof detail === "number" && Number.isFinite(detail)) details[key] = detail;
  }
  return Object.keys(details).length === 0 ? undefined : details;
}

export function serializeHarnessRequestFacetFailure(cause: unknown): HarnessRequestFacetFailure {
  const causes: HarnessRequestFacetFailureCause[] = [];
  let current: unknown = cause;
  for (let index = 0; current !== undefined && index < 8; index++) {
    const value = record(current);
    const message =
      current instanceof Error
        ? current.message
        : typeof value?.message === "string"
          ? value.message
          : String(current);
    const details = scalarDetails(value?.details);
    const item: HarnessRequestFacetFailureCause = {
      name:
        current instanceof Error
          ? current.name
          : typeof value?.name === "string"
            ? value.name
            : "Error",
      message,
      ...(typeof value?._tag === "string" ? { _tag: value._tag } : {}),
      ...(typeof value?.operation === "string" ? { operation: value.operation } : {}),
      ...(typeof value?.code === "string" ? { code: value.code } : {}),
      ...(typeof value?.kind === "string" ? { kind: value.kind } : {}),
      ...(typeof value?.recoverable === "boolean" ? { recoverable: value.recoverable } : {}),
      ...(details === undefined ? {} : { details }),
      ...(typeof value?.stack === "string" ? { stack: value.stack } : {}),
    };
    causes.push(item);
    current = value?.cause;
  }
  return causes;
}

export function restoreHarnessRequestFacetFailure(
  failure: HarnessRequestFacetFailure | undefined,
): Error | undefined {
  if (failure === undefined || failure.length === 0) return undefined;
  let cause: Error | undefined;
  for (let index = failure.length - 1; index >= 0; index--) {
    const item = failure[index]!;
    const error = new Error(item.message, cause === undefined ? undefined : { cause });
    error.name = item.name;
    if (item.stack !== undefined) error.stack = item.stack;
    Object.assign(error, {
      ...(item._tag === undefined ? {} : { _tag: item._tag }),
      ...(item.operation === undefined ? {} : { operation: item.operation }),
      ...(item.code === undefined ? {} : { code: item.code }),
      ...(item.kind === undefined ? {} : { kind: item.kind }),
      ...(item.recoverable === undefined ? {} : { recoverable: item.recoverable }),
      ...(item.details === undefined ? {} : { details: item.details }),
    });
    cause = error;
  }
  return cause;
}
