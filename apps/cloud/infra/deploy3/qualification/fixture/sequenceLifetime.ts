interface Claim {
  runId: string;
  ownerId: string;
  incarnation: string;
  phase: "held" | "released";
}
type Storage = Pick<DurableObjectStorage, "get" | "put">;
const KEY = "sequence/lifetime-claim";
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw Error(message);
}

export class QualifierSequenceLifetime {
  readonly #started = Promise.withResolvers<Claim>();
  readonly #finished = Promise.withResolvers<void>();
  #claim: Claim | undefined;
  readonly storage: Storage;
  readonly runId: string;
  readonly ownerId: string;
  readonly incarnation: string;
  constructor(storage: Storage, runId: string, ownerId: string, incarnation: string) {
    this.storage = storage;
    this.runId = runId;
    this.ownerId = ownerId;
    this.incarnation = incarnation;
  }
  async hold() {
    assert(!this.#claim, "The qualifier sequence lifetime was already claimed");
    const claim: Claim = {
      runId: this.runId,
      ownerId: this.ownerId,
      incarnation: this.incarnation,
      phase: "held",
    };
    this.#claim = claim;
    const previous = await this.storage.get<Claim>(KEY);
    assert(previous === undefined, "A durable sequence claim already exists; replay is forbidden");
    await this.storage.put(KEY, claim);
    this.#started.resolve(claim);
    await this.#finished.promise;
    return {
      runId: this.runId,
      ownerId: this.ownerId,
      incarnation: this.incarnation,
      status: "released" as const,
    };
  }
  async ready() {
    const previous = await this.storage.get<Claim>(KEY);
    if (previous !== undefined) {
      assert(
        previous.incarnation === this.incarnation && previous.phase === "held",
        "The coordinator lifetime was lost; replay is forbidden",
      );
    }
    return await this.#started.promise;
  }
  async check() {
    assert(
      this.#claim?.phase === "held",
      "The original full-sequence request is absent; replay is forbidden",
    );
    const current = await this.storage.get<Claim>(KEY);
    assert(
      current?.runId === this.runId &&
        current.ownerId === this.ownerId &&
        current.incarnation === this.incarnation &&
        current.phase === "held",
      "The qualifier sequence lifetime was fenced",
    );
  }
  async release(finished: boolean) {
    await this.check();
    assert(finished, "The sequence lifetime cannot close before the final public stop receipt");
    const claim = { ...this.#claim!, phase: "released" as const };
    await this.storage.put(KEY, claim);
    this.#claim = claim;
    this.#finished.resolve();
    return { status: "released" as const, runId: this.runId, incarnation: this.incarnation };
  }
}
