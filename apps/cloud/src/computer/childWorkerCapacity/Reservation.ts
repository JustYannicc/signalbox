import type {
  ChildWorkerPermit,
  ChildWorkerExecution,
  ChildWorkerRequester,
  ChildWorkerReservation,
  ChildWorkerSlotRequest,
} from "./types.ts";
import { childWorkerReservationBrand } from "./types.ts";

interface BoundPermit extends ChildWorkerPermit {
  bind(requester: ChildWorkerRequester): void;
}

const issuer = Symbol("ChildWorkerReservationIssuer");
const issued = new WeakSet<object>();

export function isChildWorkerReservation(value: unknown): value is ChildWorkerReservation {
  return typeof value === "object" && value !== null && issued.has(value);
}

export function issueChildWorkerReservation(
  permit: BoundPermit,
  code: ChildWorkerSlotRequest,
  onFailure: (error: unknown) => void,
): ChildWorkerReservation {
  return new ChildWorkerReservationImpl(issuer, permit, code, onFailure);
}

class ChildWorkerReservationImpl implements ChildWorkerReservation {
  readonly [childWorkerReservationBrand]: typeof childWorkerReservationBrand =
    childWorkerReservationBrand;
  readonly #permit: BoundPermit;
  readonly #code: ChildWorkerSlotRequest;
  readonly request: ChildWorkerSlotRequest;
  readonly #onFailure: (error: unknown) => void;
  #state: "unconsumed" | "consumed" | "cancelled" | "settled" = "unconsumed";

  constructor(
    token: typeof issuer,
    permit: BoundPermit,
    code: ChildWorkerSlotRequest,
    onFailure: (error: unknown) => void,
  ) {
    if (token !== issuer) throw new TypeError("Child worker reservations are capacity-owned");
    this.#permit = permit;
    this.#code = code;
    this.request = code;
    this.#onFailure = onFailure;
    issued.add(this);
    Object.freeze(this);
  }

  readonly run = async <T>(
    signal: AbortSignal,
    work: (execution: ChildWorkerExecution) => Promise<T>,
    requester: ChildWorkerRequester,
    code?: ChildWorkerSlotRequest,
  ): Promise<T> => {
    if (this.#state !== "unconsumed") {
      throw new Error("Child worker reservation is no longer available");
    }
    this.#state = "consumed";
    try {
      if (code !== undefined && code !== this.#code) {
        throw new TypeError("Child worker reservation code does not match its ProcessSlot lease");
      }
      signal.throwIfAborted();
      this.#permit.bind(requester);
    } catch (error) {
      this.#state = "settled";
      await this.#releaseUnused();
      throw error;
    }

    try {
      return await work(this.#permit.execution);
    } finally {
      this.#state = "settled";
      await this.#permit.release();
    }
  };

  readonly cancel = (): void => {
    if (this.#state !== "unconsumed") return;
    this.#state = "cancelled";
    void this.#releaseUnused().catch(() => {});
  };

  async #releaseUnused(): Promise<void> {
    try {
      await this.#permit.release();
    } catch (error) {
      this.#onFailure(error);
      throw error;
    }
  }
}
