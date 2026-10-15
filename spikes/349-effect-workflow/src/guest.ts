/**
 * The `w` receiver compiled automations call, ported from the engine's
 * `sandbox/guestRuntime.ts`. Keys are built exactly the same way (the
 * compiler's call site, `#n` for repeats in a frame, `[i]/`, `.branch/` and
 * helper frames), so a run journals under the same step keys as today.
 *
 * What it drops on purpose, and why the spike can: there is no QuickJS here,
 * so `Date.now()`, `Math.random` and `console` aren't pinned per causal
 * position, and journaled results settle when their effect completes instead
 * of in finish-time order. The built-ins the spike runs are sequential, so
 * neither changes their behaviour. A real port keeps the sandbox for both.
 */

/** Runs one step durably; the promise never settles while the run is parked. */
export interface StepHost {
  step(key: string, verb: string, label: string, args: ReadonlyArray<unknown>): Promise<unknown>;
  mark(key: string, value: unknown): void;
}

type Callback = (receiver: unknown, ...args: unknown[]) => Promise<unknown>;

export interface Definition {
  readonly __workflow: Callback;
}

const DONE = Symbol("done");
const RESTART = Symbol("restart");

/** Installs the `workflow` global compiled modules call while they load. */
export const installWorkflowGlobal = () => {
  (globalThis as { workflow?: unknown }).workflow = (fn: Callback): Definition => ({
    __workflow: fn,
  });
};

const STEP_VERBS = [
  "agent",
  "call",
  "http",
  "run",
  "llm",
  "judge",
  "extract",
  "ask",
  "notify",
  "sleep",
  "waitFor",
  "hook",
  "recall",
  "remember",
  "start",
] as const;

const receiver = (host: StepHost, prefix: string): Record<string, unknown> => {
  const seen = new Map<string, number>();
  const keyFor = (site: string) => {
    const count = seen.get(site) ?? 0;
    seen.set(site, count + 1);
    return `${prefix}${site}${count === 0 ? "" : `#${count}`}`;
  };
  const steps = Object.fromEntries(
    STEP_VERBS.map((verb) => [
      verb,
      (site: string, label: unknown, ...args: unknown[]) =>
        host.step(keyFor(site), verb, String(label), args),
    ]),
  );
  return Object.freeze({
    ...steps,
    when(site: string, _label: unknown, condition: unknown) {
      const value = Boolean(condition);
      host.mark(keyFor(site), value);
      return value;
    },
    $arm(site: string, index: number) {
      host.mark(keyFor(site), index);
    },
    done(value?: unknown) {
      return { [DONE]: true, value };
    },
    restart(input?: unknown) {
      return { [RESTART]: true, input };
    },
    $frame(site: string) {
      return receiver(host, `${keyFor(site)}/`);
    },
    async each(site: string, _label: unknown, items: Iterable<unknown>, ...rest: unknown[]) {
      const base = keyFor(site);
      const fn = rest[rest.length - 1] as Callback;
      const options = (rest.length > 1 ? rest[0] : {}) as { concurrency?: number };
      const list = Array.from(items);
      host.mark(base, { count: list.length });
      const results: unknown[] = Array.from({ length: list.length });
      let next = 0;
      const worker = async () => {
        while (next < list.length) {
          const index = next++;
          const frame = `${base}[${index}]/`;
          results[index] = await fn(receiver(host, frame), list[index], index);
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
        const outcome = (await fn(receiver(host, frame), attempt)) as
          | { [DONE]?: boolean; value?: unknown }
          | undefined;
        if (outcome && outcome[DONE]) {
          host.mark(base, { attempts: attempt + 1, done: true });
          return { done: true, value: outcome.value, attempts: attempt + 1 };
        }
      }
      host.mark(base, { attempts: options.max, done: false });
      return { done: false, attempts: options.max };
    },
    async parallel(site: string, _label: unknown, branches: Record<string, Callback>) {
      const base = keyFor(site);
      const keys = Object.keys(branches);
      const values = await Promise.all(
        keys.map((key) => branches[key]!(receiver(host, `${base}.${key}/`))),
      );
      return Object.fromEntries(keys.map((key, index) => [key, values[index]]));
    },
  });
};

export type GuestOutcome =
  | { readonly restart: false; readonly output: unknown }
  | { readonly restart: true; readonly input: unknown };

/** Starts the automation; the returned promise stays pending while a step is parked. */
export const runGuest = (
  definition: Definition,
  host: StepHost,
  input: unknown,
  trigger: unknown,
): Promise<GuestOutcome> =>
  definition
    .__workflow(
      receiver(host, ""),
      structuredClone(input ?? null),
      structuredClone(trigger ?? null),
    )
    .then((value) => {
      const restart = value as { [RESTART]?: boolean; input?: unknown } | undefined;
      return restart && typeof restart === "object" && restart[RESTART] === true
        ? { restart: true, input: restart.input ?? null }
        : { restart: false, output: value === undefined ? null : value };
    });
