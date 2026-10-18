// @effect-diagnostics globalDate:off - this code runs in the automation's Dynamic Worker, not under Effect.
import type { WorkflowStepVerb } from "@t3tools/contracts";

import type {
  AutomationRunHost,
  AutomationRunPayload,
  Marks,
  RunEnd,
  Settlement,
} from "./hostProtocol.ts";

/** Cloudflare's `WorkflowStep`, as far as the runtime uses it. */
export interface WorkflowStepLike {
  do<T>(name: string, config: StepConfig, callback: () => Promise<T>): Promise<T>;
  sleepUntil(name: string, timestamp: Date | number): Promise<void>;
  waitForEvent<T>(
    name: string,
    options: { type: string; timeout?: number },
  ): Promise<{ readonly payload: T }>;
}

export interface StepConfig {
  readonly retries: {
    readonly limit: number;
    readonly delay: string;
    readonly backoff: "exponential";
  };
  readonly timeout: string;
}

export interface AutomationRunEnv {
  readonly HOST: AutomationRunHost;
}

/** `cloudflare:workers`' `WorkerEntrypoint`, as far as the runtime uses it. */
export type EntrypointClass = new (
  ctx: unknown,
  env: AutomationRunEnv,
) => {
  readonly env: AutomationRunEnv;
};

/** The workflow body the compiled automation hands to `workflow(…)`. */
export type WorkflowBody = (w: unknown, input: unknown, trigger: unknown) => Promise<unknown>;

/** `automation.js`'s `load`: `export function load(workflow) { …; return workflow(async (w, input, trigger) => { … }) }`. */
export type LoadAutomation = (workflow: (body: WorkflowBody) => unknown) => unknown;

/**
 * Builds the `AutomationRun` entrypoint each automation version's Dynamic
 * Worker exports. It ships as source text (`runtimeSource.ts`, written from
 * `Function#toString`), so it must not reference anything outside its own
 * body; `runtime.js` passes in `WorkerEntrypoint` and the automation's `load`.
 *
 * Concurrent runs share the isolate, so all state lives inside `run`, and
 * `load` runs fresh per call so module state in the automation is per run too.
 *
 * Every step verb is one `step.do` around `HOST.step`, which answers how the
 * step starts. Cloudflare journals that answer, so a replay (after a sleep, a
 * wait, an eviction) takes the same path without asking the host again. A
 * `sleep` start sleeps in Workflows; a `waiting` start waits for the event the
 * host sends with `instance.sendEvent`, and asks `HOST.timedOut` in its own
 * step if none comes in time. `finish` is a step too (`~finish`), so a replay
 * of a finished run doesn't report it again. `settled` and `failed` are plain
 * calls: steps are billed, and the host heals a dropped one on the next
 * `step` or `finish`.
 *
 * Code between steps must be deterministic, because every replay reruns it.
 * There are no shims for that here: the validator rejects `Date.now()`,
 * `Math.random()` and `crypto` randomness in automations, and `console`
 * stays the Worker's own (the compiled `load(workflow)` gets no console).
 *
 * Keys match the QuickJS engine's (`sandbox/guestRuntime.ts`): a site reached
 * again in the same frame gets `#n`; `each` and `repeat` add `[index]` per
 * iteration, `parallel` adds `.branch`, helpers add their call site. Marks
 * (`when`, `$arm`, loop counts) buffer until the next host call; replays
 * resend them, so the host upserts by key.
 *
 * Calls at one site in one frame are numbered in call order, so code must
 * reach them in an order that doesn't depend on which concurrent step
 * finished first: replayed steps resolve in whatever order the journal
 * answers. `parallel` and `each` give every branch and item its own frame.
 */
export function defineAutomationRun(Base: EntrypointClass, load: LoadAutomation) {
  type Callback = (receiver: unknown, ...args: unknown[]) => Promise<unknown>;
  type Outcome = { [key: symbol]: unknown; value?: unknown; input?: unknown } | undefined;

  const DONE = Symbol("done");
  const RESTART = Symbol("restart");
  const DAY_MS = 86_400_000;
  /** waitForEvent accepts 1 second to 365 days. */
  const MIN_WAIT_MS = 1_000;
  const MAX_WAIT_MS = 365 * DAY_MS;
  /** Workflows rejects step names over 256 characters or with control characters. */
  const MAX_STEP_NAME = 256;
  const PLAIN_NAME = /^[\x20-\x7e]*$/;
  const HOST_CALL: StepConfig = {
    retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
    timeout: "15 minutes",
  };
  const SHAPE = "The default export must be workflow(async (w, input) => { … }).";

  const encode = (value: unknown) => JSON.stringify(value === undefined ? null : value);
  const messageOf = (error: unknown) =>
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  /** Workflows aborts a run (pause, terminate, …) by throwing through the code; never treat that as the automation's error. */
  const isEngineAbort = (error: unknown) => messageOf(error).startsWith("Aborting engine:");
  /**
   * What `waitForEvent` throws when its timeout passes: a `WorkflowTimeoutError`,
   * "Execution timed out after <ms>ms". RPC keeps `name` and `message` but not
   * the class, so both are checked.
   */
  const isWaitTimeout = (error: unknown) =>
    (error instanceof Error && error.name === "WorkflowTimeoutError") ||
    /^Execution timed out after \d+ms/.test(messageOf(error));
  /** Two FNV-1a passes, 64 bits as hex. */
  const hash = (text: string) => {
    let a = 0x811c9dc5;
    let b = 0x01000193;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      a = Math.imul(a ^ code, 0x01000193) >>> 0;
      b = Math.imul(b ^ code, 0x811c9dc5) >>> 0;
    }
    return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
  };
  /** The step that reports the end; no site key contains `~`. */
  const FINISH = "~finish";
  /** The step's Workflows name: the key itself while it fits, else a readable prefix and its hash. */
  const stepName = (key: string, suffix: string) => {
    const name = key + suffix;
    if (name.length <= MAX_STEP_NAME && PLAIN_NAME.test(name)) return name;
    const tail = `~${hash(key)}${suffix}`;
    const head = key.slice(0, MAX_STEP_NAME - tail.length).replace(/[^\x20-\x7e]/g, "_");
    return head + tail;
  };
  const failure = (error: string, detail?: unknown) =>
    detail === undefined ? new Error(error) : Object.assign(new Error(error), { detail });
  const settle = (settlement: Settlement) => {
    if (settlement.ok) return settlement.value;
    throw failure(settlement.error, settlement.detail);
  };
  /** Best-effort host notices: the outcome stands even when the host can't be told. */
  const tell = async (notice: () => Promise<void>) => {
    try {
      await notice();
    } catch {
      // The host catches up on the next `step` or `finish`.
    }
  };

  return class AutomationRun extends Base {
    async run(event: { readonly payload: AutomationRunPayload }, step: WorkflowStepLike) {
      const host = this.env.HOST;
      const { runId, input, trigger } = event.payload;
      const pending = new Map<string, unknown>();
      let aborted: { error: unknown } | undefined;

      /**
       * Sends the marks buffered so far with `call` and returns which keys went
       * along; puts them back if it fails.
       */
      const withMarks = async <T>(call: (marks: Marks) => Promise<T>) => {
        const batch = [...pending];
        pending.clear();
        try {
          return { result: await call(batch), sent: batch.map(([key]) => key) };
        } catch (error) {
          for (const [key, value] of batch) if (!pending.has(key)) pending.set(key, value);
          throw error;
        }
      };
      /** A replayed step already delivered these marks; don't send them again. */
      const delivered = (sent: ReadonlyArray<string>) => {
        for (const key of sent) pending.delete(key);
      };
      /** The step failed for the code: tell the host, then reject like a failed start. */
      const fail = async (key: string, error: unknown): Promise<never> => {
        if (isEngineAbort(error)) throw error;
        const message = messageOf(error);
        await tell(() => host.failed(runId, key, message));
        throw new Error(message, { cause: error });
      };
      /** One journaled host call; when Cloudflare stops retrying, the step fails for the code. */
      const journaled = async <T>(key: string, name: string, call: () => Promise<T>) => {
        try {
          return await step.do(name, HOST_CALL, call);
        } catch (error) {
          return fail(key, error);
        }
      };
      const begin = async (key: string, verb: WorkflowStepVerb, label: string, args: unknown) => {
        const request = { key, verb, label, args: JSON.parse(encode(args)) as unknown[] };
        const { result: start, sent } = await journaled(key, stepName(key, ""), () =>
          withMarks((marks) => host.step(runId, request, marks)),
        );
        delivered(sent);
        switch (start.type) {
          case "done":
            return start.value;
          case "failed":
            throw failure(start.error, start.detail);
          case "sleep":
            // Workflows refuses to sleep until a past time, which a replay
            // after the wake would otherwise ask for.
            if (start.until > Date.now()) {
              await step.sleepUntil(stepName(key, "~sleep"), new Date(start.until));
            }
            await tell(() => host.settled(runId, key, null));
            return null;
          case "waiting": {
            let settlement: Settlement;
            try {
              const timeout = Math.min(
                MAX_WAIT_MS,
                Math.max(MIN_WAIT_MS, start.timeoutMs ?? MAX_WAIT_MS),
              );
              const received = await step.waitForEvent<Settlement>(stepName(key, "~wait"), {
                type: start.event,
                timeout,
              });
              settlement = received.payload;
            } catch (error) {
              if (!isWaitTimeout(error)) return fail(key, error);
              settlement = await journaled(key, stepName(key, "~timeout"), () =>
                host.timedOut(runId, key),
              );
            }
            return settle(settlement);
          }
        }
      };
      const verbStep = async (
        key: string,
        verb: WorkflowStepVerb,
        label: string,
        args: unknown,
      ) => {
        // Once the engine aborted, the run is going away: start nothing new.
        if (aborted) throw aborted.error;
        try {
          return await begin(key, verb, label, args);
        } catch (error) {
          if (isEngineAbort(error)) aborted ??= { error };
          throw error;
        }
      };

      const receiver = (prefix: string): Record<string, unknown> => {
        const seen = new Map<string, number>();
        /** The key for this call of `site`, counting repeats within this frame. */
        const keyFor = (site: string) => {
          const count = seen.get(site) ?? 0;
          seen.set(site, count + 1);
          return `${prefix}${site}${count === 0 ? "" : `#${count}`}`;
        };
        const verb =
          (name: WorkflowStepVerb) =>
          (site: string, label: unknown, ...args: unknown[]): Promise<unknown> =>
            verbStep(keyFor(site), name, String(label), args);

        const verbs = {
          agent: verb("agent"),
          call: verb("call"),
          http: verb("http"),
          run: verb("run"),
          llm: verb("llm"),
          judge: verb("judge"),
          extract: verb("extract"),
          ask: verb("ask"),
          notify: verb("notify"),
          sleep: verb("sleep"),
          waitFor: verb("waitFor"),
          eventCursor: verb("eventCursor"),
          hook: verb("hook"),
          recall: verb("recall"),
          remember: verb("remember"),
          start: verb("start"),
        } satisfies Record<WorkflowStepVerb, unknown>;

        return Object.freeze({
          ...verbs,
          when(site: string, _label: unknown, condition: unknown) {
            const value = Boolean(condition);
            pending.set(keyFor(site), value);
            return value;
          },
          /** Records that option `index` of a decision, loop pass, or try path was taken. */
          $arm(site: string, index: number) {
            pending.set(keyFor(site), index);
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
            pending.set(base, { count: list.length });
            const results: unknown[] = Array.from({ length: list.length });
            let next = 0;
            const worker = async () => {
              while (next < list.length) {
                const index = next++;
                results[index] = await fn(receiver(`${base}[${index}]/`), list[index], index);
              }
            };
            const workers = Math.max(1, Math.min(options.concurrency ?? 1, list.length));
            await Promise.all(Array.from({ length: workers }, worker));
            return results;
          },
          async repeat(site: string, _label: unknown, options: { max: number }, fn: Callback) {
            const base = keyFor(site);
            for (let attempt = 0; attempt < options.max; attempt++) {
              const outcome = (await fn(receiver(`${base}[${attempt}]/`), attempt)) as Outcome;
              if (outcome && outcome[DONE]) {
                pending.set(base, { attempts: attempt + 1, done: true });
                return { done: true, value: outcome.value, attempts: attempt + 1 };
              }
            }
            pending.set(base, { attempts: options.max, done: false });
            return { done: false, attempts: options.max };
          },
          async parallel(site: string, _label: unknown, branches: Record<string, Callback>) {
            const base = keyFor(site);
            const keys = Object.keys(branches);
            const values = await Promise.all(
              keys.map((key) => branches[key]!(receiver(`${base}.${key}/`))),
            );
            return Object.fromEntries(keys.map((key, index) => [key, values[index]]));
          },
        });
      };

      /** Reports how the run ended, once: a replay of a finished run gets it from the journal. */
      const finish = async (outcome: RunEnd) => {
        const end = JSON.parse(encode(outcome)) as RunEnd;
        await step.do(FINISH, HOST_CALL, async () => {
          await withMarks((marks) => host.finish(runId, end, marks));
          return null;
        });
        return end;
      };

      let value: Outcome;
      try {
        const definition = load((body) => ({ __workflow: body })) as
          | { __workflow?: WorkflowBody }
          | undefined;
        const body = definition?.__workflow;
        if (typeof body !== "function") throw new Error(SHAPE);
        value = (await body(receiver(""), input, trigger)) as Outcome;
      } catch (error) {
        if (aborted) throw aborted.error;
        if (isEngineAbort(error)) throw error;
        await finish({ type: "failed", error: messageOf(error) });
        throw error;
      }
      // Code that caught an engine abort must not finish the run.
      if (aborted) throw aborted.error;
      const end = await finish(
        value && typeof value === "object" && value[RESTART] === true
          ? { type: "restart", input: value.input ?? null }
          : { type: "completed", output: value },
      );
      return end.type === "completed" ? end.output : null;
    }
  };
}
