export class CliWorkingSetLimit extends Error {
  readonly code = "CLI_FS_WORKING_SET_LIMIT";
  readonly requested;
  readonly available;
  constructor(requested: number, available: number) {
    super(`CLI filesystem working set needs ${requested} bytes; ${available} bytes remain`);
    this.requested = requested;
    this.available = available;
  }
}

/** Counts retained content and queued write payloads, including their simultaneous copies. */
export class CliWorkingSetBudget {
  #used = 0;
  readonly limit;
  constructor(limit: number) {
    this.limit = limit;
    if (!Number.isSafeInteger(limit) || limit < 0)
      throw new RangeError("CLI filesystem byte limit must be a non-negative safe integer");
  }
  get used() {
    return this.#used;
  }
  reserve(bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw new RangeError("Invalid CLI filesystem byte reservation");
    if (bytes > this.limit - this.#used)
      throw new CliWorkingSetLimit(bytes, this.limit - this.#used);
    this.#used += bytes;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#used -= bytes;
    };
  }
}
