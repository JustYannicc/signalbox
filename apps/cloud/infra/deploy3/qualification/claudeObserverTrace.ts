export interface ClaudeQualificationRoute {
  readonly method: string;
  readonly path: string;
}

export interface ClaudeQualificationEventPin {
  readonly identity: string;
  readonly entrypoint: string;
  readonly tag: string;
  readonly route: ClaudeQualificationRoute;
  readonly invocationId: string;
}

export interface ClaudeQualificationObserverTrace {
  /** Extracted producerEvent payloads from the pinned Worker Tail records. */
  readonly producerEvents: readonly unknown[];
  /** Matching observerFailure payloads from the same Tail records. */
  readonly observerFailures: readonly unknown[];
}

interface ProducerEvent extends ClaudeQualificationEventPin {
  readonly schema: "sb1070/producer/v1";
  readonly runId: string;
  readonly producerClass: string;
  readonly workerId: string;
  readonly milestone: "entered" | "terminal";
  readonly isolateNonce?: string;
}

interface ObserverFailure {
  readonly identity: string;
  readonly invocationId: string;
}

export function requireObservedInvocation(
  actual: {
    readonly events: readonly ProducerEvent[];
    readonly failures: readonly ObserverFailure[];
  },
  runId: string,
  pin: ClaudeQualificationEventPin,
) {
  const matches = actual.events
    .map((event, index) => ({ event, index }))
    .filter(
      ({ event }) =>
        event.runId === runId &&
        event.identity === pin.identity &&
        event.producerClass === "dynamic-worker" &&
        event.entrypoint === pin.entrypoint &&
        event.tag === pin.tag &&
        event.route.method === pin.route.method &&
        event.route.path === pin.route.path &&
        event.invocationId === pin.invocationId,
    );
  const entered = matches.filter(({ event }) => event.milestone === "entered");
  const terminal = matches.filter(({ event }) => event.milestone === "terminal");
  if (entered.length !== 1 || terminal.length !== 1 || entered[0]!.index >= terminal[0]!.index)
    throw new Error("CLAUDE_QUALIFICATION_WORKLOAD_EVENT_INCOMPLETE");
  if (entered[0]!.event.workerId !== terminal[0]!.event.workerId)
    throw new Error("CLAUDE_QUALIFICATION_WORKLOAD_EVENT_IDENTITY_CHANGED");
  if (
    actual.failures.some(
      (failure) => failure.identity === pin.identity && failure.invocationId === pin.invocationId,
    )
  )
    throw new Error("CLAUDE_QUALIFICATION_WORKLOAD_OPERATION_FAILED");
  return {
    entered: entered[0]!.event,
    terminal: terminal[0]!.event,
    enteredIndex: entered[0]!.index,
    terminalIndex: terminal[0]!.index,
  };
}

export function readObserverTrace(trace: ClaudeQualificationObserverTrace) {
  return {
    events: trace.producerEvents.map(decodeProducerEvent),
    failures: trace.observerFailures.map(decodeObserverFailure),
  };
}

function decodeProducerEvent(value: unknown): ProducerEvent {
  const raw = record(value);
  const route = record(raw?.route);
  const isolateNonce = raw?.isolateNonce;
  if (
    raw?.schema !== "sb1070/producer/v1" ||
    typeof raw.runId !== "string" ||
    !raw.runId ||
    typeof raw.identity !== "string" ||
    !raw.identity ||
    typeof raw.producerClass !== "string" ||
    typeof raw.workerId !== "string" ||
    !raw.workerId ||
    typeof raw.entrypoint !== "string" ||
    !raw.entrypoint ||
    typeof raw.tag !== "string" ||
    !raw.tag ||
    typeof route?.method !== "string" ||
    !route.method ||
    typeof route.path !== "string" ||
    !route.path.startsWith("/") ||
    typeof raw.invocationId !== "string" ||
    !raw.invocationId ||
    (raw.milestone !== "entered" && raw.milestone !== "terminal") ||
    (isolateNonce !== undefined && (typeof isolateNonce !== "string" || !isolateNonce))
  )
    throw new Error("CLAUDE_QUALIFICATION_OBSERVER_EVENT_INVALID");
  return {
    schema: "sb1070/producer/v1",
    runId: raw.runId,
    identity: raw.identity,
    producerClass: raw.producerClass,
    workerId: raw.workerId,
    entrypoint: raw.entrypoint,
    tag: raw.tag,
    route: { method: route.method, path: route.path },
    invocationId: raw.invocationId,
    milestone: raw.milestone,
    ...(typeof isolateNonce === "string" ? { isolateNonce } : {}),
  };
}

function decodeObserverFailure(value: unknown): ObserverFailure {
  const raw = record(value);
  if (
    typeof raw?.identity !== "string" ||
    !raw.identity ||
    typeof raw.invocationId !== "string" ||
    !raw.invocationId
  )
    throw new Error("CLAUDE_QUALIFICATION_OBSERVER_FAILURE_INVALID");
  return { identity: raw.identity, invocationId: raw.invocationId };
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function validPin(pin: ClaudeQualificationEventPin) {
  const route = record(pin.route);
  return Boolean(
    typeof pin.identity === "string" &&
    pin.identity &&
    typeof pin.entrypoint === "string" &&
    pin.entrypoint &&
    typeof pin.tag === "string" &&
    pin.tag &&
    typeof route?.method === "string" &&
    route.method &&
    typeof route.path === "string" &&
    route.path.startsWith("/") &&
    typeof pin.invocationId === "string" &&
    pin.invocationId,
  );
}
