import type { KernelAsyncProgram } from "../KernelAsyncProgram.ts";
import type {
  KernelProgramAdmissionDecision,
  KernelProgramAdmissionRequest,
} from "../KernelProgramAdmission.ts";
import type { KernelProgramImplementation } from "./KernelProgramRuntime.ts";

export type KernelProgramAdmissionResume =
  | {
      readonly kind: "selected";
      readonly route: "local" | "forward";
      readonly implementation: KernelProgramImplementation;
      readonly admission?: object;
    }
  | {
      readonly kind: "unsupported";
      readonly code: "NOT_FOUND" | "UNSUPPORTED";
      readonly message: string;
    };

/** One policy decision resumes one captured launch exactly once. */
export class KernelProgramAdmissionTicket {
  readonly #request: KernelProgramAdmissionRequest;
  readonly #decision: KernelProgramAdmissionDecision;
  readonly #cancel: (() => void) | undefined;
  readonly #assertCurrent: (() => void) | undefined;
  #resumed = false;
  #asserted = false;
  #bodyStarted = false;
  #dispatched = false;
  #cancelled = false;
  #cancelFailure: unknown;

  private constructor(
    request: KernelProgramAdmissionRequest,
    decision: KernelProgramAdmissionDecision,
    cancel: (() => void) | undefined,
    assertCurrent: (() => void) | undefined,
  ) {
    this.#request = request;
    this.#decision = decision;
    this.#cancel = cancel;
    this.#assertCurrent = assertCurrent;
  }

  static from(request: KernelProgramAdmissionRequest, candidate: unknown) {
    const cancel = readCancel(candidate);
    try {
      const decision = snapshotDecision(candidate);
      return new KernelProgramAdmissionTicket(request, decision, cancel, decision.assertCurrent);
    } catch (error) {
      callCancel(cancel);
      throw error;
    }
  }

  resume(): KernelProgramAdmissionResume {
    if (this.#resumed) throw new Error("Kernel program admission ticket was already resumed");
    this.#resumed = true;
    if (this.#decision.kind === "local") {
      if (this.#request.target.kind === "unsupported") {
        this.cancel();
        return {
          kind: "unsupported",
          code: this.#request.target.code,
          message: this.#request.target.message,
        };
      }
      return {
        kind: "selected",
        route: "local",
        implementation: withDispatch(
          this.#request.target.binding.implementation,
          this.#decision.onDispatch,
          () => {
            this.#dispatched = true;
          },
        ),
        ...(this.#decision.admission === undefined ? {} : { admission: this.#decision.admission }),
      };
    }
    return {
      kind: "selected",
      route: "forward",
      implementation: withDispatch(this.#decision.implementation, this.#decision.onDispatch, () => {
        this.#dispatched = true;
      }),
      ...(this.#decision.admission === undefined ? {} : { admission: this.#decision.admission }),
    };
  }

  /** Checks that the adapter still owns the admitted grant before any effects. */
  assertCurrent(): void {
    if (!this.#resumed) throw new Error("Kernel program admission ticket was not resumed");
    if (this.#asserted) throw new Error("Kernel program admission ticket was already checked");
    this.#asserted = true;
    this.#assertCurrent?.();
  }

  /** Called at the last synchronous point before the chosen program body starts. */
  beginBody(signal: AbortSignal): boolean {
    if (!this.#resumed) throw new Error("Kernel program admission ticket was not resumed");
    if (!this.#asserted) throw new Error("Kernel program admission ticket was not checked");
    if (this.#bodyStarted) throw new Error("Kernel program admission ticket already started");
    if (signal.aborted) {
      this.cancel();
      return false;
    }
    this.#bodyStarted = true;
    return true;
  }

  /** Unused grants are released early; dispatched grants belong to the adapter. */
  cancel(): void {
    if (this.#cancelled || this.#dispatched) return;
    this.#cancelled = true;
    try {
      this.#cancel?.();
    } catch (error) {
      this.#cancelFailure = error;
    }
  }

  throwCancelFailure(): void {
    if (this.#cancelFailure !== undefined) throw this.#cancelFailure;
  }
}

function readCancel(candidate: unknown): (() => void) | undefined {
  if (!isRecord(candidate)) return undefined;
  const cancel = candidate.cancel;
  return typeof cancel === "function" ? () => cancel.call(candidate) : undefined;
}

function snapshotDecision(candidate: unknown): KernelProgramAdmissionDecision {
  if (!isRecord(candidate)) throw invalidDecision();
  const admission = candidate.admission;
  if (admission !== undefined && !isObject(admission)) throw invalidDecision();
  const cancel = candidate.cancel;
  if (cancel !== undefined && !isVoidFunction(cancel)) throw invalidDecision();
  const assertCurrent = candidate.assertCurrent;
  if (assertCurrent !== undefined && !isVoidFunction(assertCurrent)) throw invalidDecision();
  const onDispatch = candidate.onDispatch;
  if (onDispatch !== undefined && !isDispatchFunction(onDispatch)) throw invalidDecision();
  if (candidate.kind === "local") {
    if (!hasOnlyKeys(candidate, ["kind", "admission", "cancel", "assertCurrent", "onDispatch"])) {
      throw invalidDecision();
    }
    return Object.freeze({
      kind: "local",
      ...(admission === undefined ? {} : { admission }),
      ...(cancel === undefined ? {} : { cancel }),
      ...(assertCurrent === undefined ? {} : { assertCurrent }),
      ...(onDispatch === undefined ? {} : { onDispatch }),
    });
  }
  if (candidate.kind === "forward" && isRecord(candidate.implementation)) {
    const implementation = candidate.implementation;
    if (
      !hasOnlyKeys(candidate, [
        "kind",
        "implementation",
        "admission",
        "cancel",
        "assertCurrent",
        "onDispatch",
      ]) ||
      !hasOnlyKeys(implementation, ["kind", "run", "sigpipe"]) ||
      implementation.kind !== "async" ||
      (implementation.sigpipe !== undefined &&
        implementation.sigpipe !== "terminate" &&
        implementation.sigpipe !== "epipe") ||
      !isProgramRun(implementation.run)
    ) {
      throw invalidDecision();
    }
    return Object.freeze({
      kind: "forward",
      implementation: Object.freeze({
        kind: "async",
        run: implementation.run,
        ...(implementation.sigpipe === undefined ? {} : { sigpipe: implementation.sigpipe }),
      }),
      ...(admission === undefined ? {} : { admission }),
      ...(cancel === undefined ? {} : { cancel }),
      ...(assertCurrent === undefined ? {} : { assertCurrent }),
      ...(onDispatch === undefined ? {} : { onDispatch }),
    });
  }
  throw invalidDecision();
}

function callCancel(cancel: (() => void) | undefined): void {
  if (cancel === undefined) return;
  try {
    cancel();
  } catch {
    // The invalid decision remains the primary failure.
  }
}

function invalidDecision(): TypeError {
  return new TypeError("Invalid kernel program admission decision");
}

function withDispatch(
  implementation: KernelProgramImplementation,
  onDispatch: KernelProgramAdmissionDecision["onDispatch"],
  markDispatched: () => void,
): KernelProgramImplementation {
  if (implementation.kind !== "async") {
    if (onDispatch !== undefined) {
      throw new TypeError("Kernel program admission dispatch requires an async implementation");
    }
    return implementation;
  }
  return Object.freeze({
    kind: "async",
    ...(implementation.sigpipe === undefined ? {} : { sigpipe: implementation.sigpipe }),
    run: (context) => {
      onDispatch?.(context);
      markDispatched();
      return implementation.run(context);
    },
  });
}

function isVoidFunction(value: unknown): value is () => void {
  return typeof value === "function";
}

function isDispatchFunction(
  value: unknown,
): value is NonNullable<KernelProgramAdmissionDecision["onDispatch"]> {
  return typeof value === "function";
}

function isProgramRun(value: unknown): value is KernelAsyncProgram["run"] {
  return typeof value === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
