// @effect-diagnostics globalDate:off - this code runs inside the QuickJS sandbox, not under Effect.
/**
 * The receiver automations call, installed inside the QuickJS sandbox before
 * the compiled module runs. It is serialized with `Function#toString`, so it
 * must not reference anything outside its own body.
 *
 * Step calls go to `host.step(key, verb, label, argsJson)`, which answers
 * synchronously: an `{ ok, value | error, at }` envelope when the journal has
 * the result, or null while the step is still pending. Pending steps return a
 * promise that never settles; the run suspends and the next replay picks up
 * once the step finishes. Journaled results don't settle at call time: they
 * queue, and the host calls `__settleNext()` once the job queue is empty to
 * settle the one that finished first (ties by call order). Concurrent
 * branches therefore resume in the order they really did, whatever else the
 * journal holds by now.
 *
 * Keys follow the graph ids the compiler injects. A site reached again in the
 * same frame gets `#n`; `each` and `repeat` add `[index]` per iteration,
 * `parallel` adds `.branch`, helpers add their call site.
 * `workflowNodeIdForStepKey` maps a key back to its graph node.
 *
 * Time and randomness are deterministic per causal position so replays agree.
 * `Date.now()` is the run's start until a step settles; settling a step sets
 * it to the later of the step's finish time and the time its caller saw.
 * `Math.random`/`crypto` draw from a stream seeded by the run and a key: the
 * root stream is "", a settled step switches to its own key, and each
 * `parallel` branch, `each` item and `repeat` attempt starts on its frame's.
 * `console` goes to `host.log` stamped with that same time.
 */
export function installGuestRuntime() {
  interface Host {
    readonly seed: number;
    readonly startedAt: number;
    step(key: string, verb: string, label: string, args: string): string | null;
    mark(key: string, value: string): void;
    log(level: string, message: string, at: number): void;
  }
  type Callback = (receiver: unknown, ...args: unknown[]) => Promise<unknown>;
  interface Ready {
    readonly key: string;
    readonly order: number;
    readonly at: number;
    readonly callerNow: number;
    readonly result: { ok: boolean; value?: unknown; error?: string };
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: Error) => void;
  }

  const scope = globalThis as unknown as Record<string, unknown>;
  const host = scope.__host as Host;
  delete scope.__host;
  const DONE = Symbol("done");
  const RESTART = Symbol("restart");
  const never = new Promise<never>(() => {});
  const encode = (value: unknown) => JSON.stringify(value === undefined ? null : value);

  let now = host.startedAt;
  const RealDate = Date;
  function DeterministicDate(this: unknown, ...args: unknown[]) {
    if (!new.target) return new RealDate(now).toString();
    return args.length === 0
      ? new RealDate(now)
      : new (RealDate as unknown as new (...values: unknown[]) => Date)(...args);
  }
  DeterministicDate.prototype = RealDate.prototype;
  DeterministicDate.now = () => now;
  DeterministicDate.parse = RealDate.parse;
  DeterministicDate.UTC = RealDate.UTC;
  scope.Date = DeterministicDate;

  let state = 0;
  /** Switches to the stream for `key`: FNV-1a over the key, continued from the run's seed. */
  const reseed = (key: string) => {
    let hash = host.seed >>> 0;
    for (let index = 0; index < key.length; index++) {
      hash ^= key.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    state = hash;
  };
  reseed("");
  /** Mulberry32. */
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  /** Starts a branch, item or attempt on its frame's stream, then gives the caller its own back. */
  const spawn = <T>(prefix: string, start: () => T): T => {
    const saved = state;
    reseed(prefix);
    try {
      return start();
    } finally {
      state = saved;
    }
  };
  Math.random = random;
  const byte = () => Math.floor(random() * 256);
  scope.crypto = {
    getRandomValues<T extends { length: number; [index: number]: number }>(array: T) {
      for (let index = 0; index < array.length; index++) array[index] = byte();
      return array;
    },
    randomUUID() {
      const bytes = Array.from({ length: 16 }, byte);
      bytes[6] = (bytes[6]! & 0x0f) | 0x40;
      bytes[8] = (bytes[8]! & 0x3f) | 0x80;
      const hex = bytes.map((value) => value.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
  };

  const format = (value: unknown) => {
    if (typeof value === "string") return value;
    if (value instanceof Error) return String(value);
    try {
      const json = JSON.stringify(value);
      if (json !== undefined) return json;
    } catch {
      // Cycles and BigInts fall through to String.
    }
    try {
      return String(value);
    } catch {
      return Object.prototype.toString.call(value);
    }
  };
  const logger =
    (level: string) =>
    (...values: unknown[]) =>
      host.log(level, values.map(format).join(" "), now);
  scope.console = Object.freeze({
    log: logger("log"),
    info: logger("info"),
    warn: logger("warn"),
    error: logger("error"),
    debug: logger("debug"),
  });

  const ready: Ready[] = [];
  let calls = 0;
  scope.__settleNext = () => {
    let next = -1;
    for (let index = 0; index < ready.length; index++) {
      const entry = ready[index]!;
      const best = ready[next];
      if (!best || entry.at < best.at || (entry.at === best.at && entry.order < best.order))
        next = index;
    }
    if (next < 0) return false;
    const [entry] = ready.splice(next, 1) as [Ready];
    now = Math.max(entry.callerNow, entry.at);
    reseed(entry.key);
    if (entry.result.ok) entry.resolve(entry.result.value);
    else entry.reject(new Error(entry.result.error));
    return true;
  };

  function receiver(prefix: string): Record<string, unknown> {
    const seen = new Map<string, number>();
    /** The key for this call of `site`, counting repeats within this frame. */
    const keyFor = (site: string) => {
      const count = seen.get(site) ?? 0;
      seen.set(site, count + 1);
      return `${prefix}${site}${count === 0 ? "" : `#${count}`}`;
    };
    const step =
      (verb: string) =>
      (site: string, label: unknown, ...args: unknown[]): Promise<unknown> => {
        const key = keyFor(site);
        const answer = host.step(key, verb, String(label), encode(args));
        if (answer === null) return never;
        const result = JSON.parse(answer) as Ready["result"] & { at: number };
        const callerNow = now;
        const order = calls++;
        return new Promise((resolve, reject) => {
          ready.push({ key, order, at: result.at, callerNow, result, resolve, reject });
        });
      };

    return Object.freeze({
      agent: step("agent"),
      call: step("call"),
      http: step("http"),
      run: step("run"),
      llm: step("llm"),
      judge: step("judge"),
      extract: step("extract"),
      ask: step("ask"),
      notify: step("notify"),
      sleep: step("sleep"),
      waitFor: step("waitFor"),
      recall: step("recall"),
      remember: step("remember"),
      start: step("start"),
      when(site: string, _label: unknown, condition: unknown) {
        const value = Boolean(condition);
        host.mark(keyFor(site), encode(value));
        return value;
      },
      /** Records that option `index` of a decision, loop pass, or try path was taken. */
      $arm(site: string, index: number) {
        host.mark(keyFor(site), encode(index));
      },
      done(value?: unknown) {
        return { [DONE]: true, value };
      },
      /** `return w.restart(input)` from the workflow: end this run and start a fresh one. */
      restart(input?: unknown) {
        return { [RESTART]: true, input };
      },
      $frame(site: string) {
        return receiver(`${keyFor(site)}/`);
      },
      async each(site: string, _label: unknown, items: Iterable<unknown>, ...rest: unknown[]) {
        const base = keyFor(site);
        const fn = rest[rest.length - 1] as Callback;
        const options = (rest.length > 1 ? rest[0] : {}) as { concurrency?: number };
        const list = Array.from(items);
        host.mark(base, encode({ count: list.length }));
        const results: unknown[] = Array.from({ length: list.length });
        let next = 0;
        const worker = async () => {
          while (next < list.length) {
            const index = next++;
            const frame = `${base}[${index}]/`;
            results[index] = await spawn(frame, () => fn(receiver(frame), list[index], index));
          }
        };
        const workers = Math.max(1, Math.min(options.concurrency ?? 1, list.length));
        await Promise.all(Array.from({ length: workers }, worker));
        return results;
      },
      async repeat(site: string, _label: unknown, options: { max: number }, fn: Callback) {
        const base = keyFor(site);
        for (let attempt = 0; attempt < options.max; attempt++) {
          const frame = `${base}[${attempt}]/`;
          const outcome = (await spawn(frame, () => fn(receiver(frame), attempt))) as
            | { [DONE]?: boolean; value?: unknown }
            | undefined;
          if (outcome && outcome[DONE]) {
            host.mark(base, encode({ attempts: attempt + 1, done: true }));
            return { done: true, value: outcome.value, attempts: attempt + 1 };
          }
        }
        host.mark(base, encode({ attempts: options.max, done: false }));
        return { done: false, attempts: options.max };
      },
      async parallel(site: string, _label: unknown, branches: Record<string, Callback>) {
        const base = keyFor(site);
        const keys = Object.keys(branches);
        const values = await Promise.all(
          keys.map((key) => {
            const frame = `${base}.${key}/`;
            return spawn(frame, () => branches[key]!(receiver(frame)));
          }),
        );
        return Object.fromEntries(keys.map((key, index) => [key, values[index]]));
      },
    });
  }

  scope.workflow = (fn: Callback) => ({ __workflow: fn });
  scope.__run = (
    definition: { __workflow?: Callback } | undefined,
    input: string,
    trigger: string,
  ) => {
    if (!definition || typeof definition.__workflow !== "function") {
      throw new Error("The default export must be workflow(async (w, input) => { … }).");
    }
    return definition
      .__workflow(receiver(""), JSON.parse(input), JSON.parse(trigger))
      .then((value) => {
        const restart = value as { [RESTART]?: boolean; input?: unknown } | undefined;
        return restart && typeof restart === "object" && restart[RESTART] === true
          ? JSON.stringify({ restart: true, input: restart.input ?? null })
          : JSON.stringify({ restart: false, output: value === undefined ? null : value });
      });
  };
}
