// @effect-diagnostics globalDate:off globalTimers:off - fake Workflows time is Date, as Workers' is.
import { vi } from "@effect/vitest";

import type {
  AutomationRunHost,
  Marks,
  RunEnd,
  Settlement,
  StepRequest,
  HostStepStart,
} from "./hostProtocol.ts";
import type { StepConfig, WorkflowStepLike } from "./runtime.ts";

type Cached =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: unknown };

interface Sleeper {
  readonly name: string;
  readonly until: number;
  readonly resolve: () => void;
}

interface Waiter {
  readonly name: string;
  readonly type: string;
  readonly timeout: number;
  readonly deadline: number;
  readonly resolve: (event: { payload: unknown }) => void;
  readonly reject: (error: unknown) => void;
}

/** Workflows rejects names over 256 characters or with control characters. */
const validName = (name: string) =>
  name.length <= 256 &&
  [...name].every((char) => char.charCodeAt(0) >= 0x20 && char.charCodeAt(0) !== 0x7f);

/**
 * Cloudflare Workflows' step semantics, in memory: `do` results (and final
 * errors) are journaled by name, so calling `run` again with `step()` replays
 * from the top; `sleepUntil` and `waitForEvent` block until `advance` or
 * `sendEvent`, and events sent before anyone waits are buffered. Time is
 * `Date.now()`; tests fake it with `vi.useFakeTimers({ toFake: ["Date"] })`.
 */
export class FakeWorkflows {
  readonly journal = new Map<string, Cached>();
  readonly sleeps = new Set<string>();
  readonly events = new Map<string, Cached>();
  /** Every step name each `step()` handle saw, in call order. */
  readonly runs: string[][] = [];
  /** How many times a `do` callback ran, retries included. */
  attempts = 0;
  private readonly buffered = new Map<string, unknown[]>();
  private sleeping: Sleeper[] = [];
  private waiting: Waiter[] = [];

  /** A fresh step handle, as the engine passes to each `run` (a replay starts a new one). */
  step(): WorkflowStepLike {
    const names: string[] = [];
    this.runs.push(names);
    const claim = (name: string) => {
      if (!validName(name))
        throw new Error(
          `Step name "${name}" exceeds max length (256 chars) or invalid characters found`,
        );
      if (names.includes(name)) throw new Error(`Step name "${name}" used twice in one run`);
      names.push(name);
    };
    return {
      do: async <T>(name: string, config: StepConfig, callback: () => Promise<T>) => {
        claim(name);
        const cached = this.journal.get(name);
        if (cached) {
          if (cached.ok) return cached.value as T;
          throw cached.error;
        }
        let last: unknown;
        for (let attempt = 0; attempt <= config.retries.limit; attempt++) {
          this.attempts++;
          try {
            const value = structuredClone(await callback());
            this.journal.set(name, { ok: true, value });
            return value;
          } catch (error) {
            last = error;
          }
        }
        this.journal.set(name, { ok: false, error: last });
        throw last;
      },
      sleepUntil: async (name: string, timestamp: Date | number) => {
        claim(name);
        if (this.sleeps.has(name)) return;
        const until = +timestamp;
        if (until < Date.now())
          throw new Error("You can't sleep until a time in the past, time-traveler");
        await new Promise<void>((resolve) => this.sleeping.push({ name, until, resolve }));
      },
      waitForEvent: async <T>(name: string, options: { type: string; timeout?: number }) => {
        claim(name);
        const cached = this.events.get(name);
        if (cached) {
          if (cached.ok) return { payload: cached.value as T };
          throw cached.error;
        }
        const queue = this.buffered.get(options.type);
        if (queue && queue.length > 0) {
          const payload = queue.shift();
          this.events.set(name, { ok: true, value: payload });
          return { payload: payload as T };
        }
        const timeout = options.timeout ?? 86_400_000;
        return new Promise<{ payload: T }>((resolve, reject) =>
          this.waiting.push({
            name,
            type: options.type,
            timeout,
            deadline: Date.now() + timeout,
            resolve: resolve as (event: { payload: unknown }) => void,
            reject,
          }),
        );
      },
    };
  }

  /** `instance.sendEvent`: wakes the first waiter for `type`, or buffers the payload. */
  sendEvent(type: string, payload: Settlement) {
    const waiter = this.waiting.find((entry) => entry.type === type);
    if (!waiter) {
      this.buffered.set(type, [...(this.buffered.get(type) ?? []), payload]);
      return;
    }
    this.waiting = this.waiting.filter((entry) => entry !== waiter);
    this.events.set(waiter.name, { ok: true, value: payload });
    waiter.resolve({ payload });
  }

  /** Moves time on, waking sleeps that are due and timing out waits that are. */
  advance(ms: number) {
    vi.setSystemTime(Date.now() + ms);
    const now = Date.now();
    for (const sleeper of this.sleeping.filter((entry) => entry.until <= now)) {
      this.sleeps.add(sleeper.name);
      sleeper.resolve();
    }
    this.sleeping = this.sleeping.filter((entry) => entry.until > now);
    for (const waiter of this.waiting.filter((entry) => entry.deadline <= now)) {
      const error = Object.assign(new Error(`Execution timed out after ${waiter.timeout}ms`), {
        name: "WorkflowTimeoutError",
      });
      this.events.set(waiter.name, { ok: false, error });
      waiter.reject(error);
    }
    this.waiting = this.waiting.filter((entry) => entry.deadline > now);
  }

  /** The engine hibernates: whatever was blocked never resumes in this invocation. */
  evict() {
    this.sleeping = [];
    this.waiting = [];
  }

  /** Names of the sleeps and waits the run is blocked on. */
  blocked() {
    return [
      ...this.sleeping.map((entry) => entry.name),
      ...this.waiting.map((entry) => entry.name),
    ];
  }

  /** Lets every pending microtask and RPC-shaped hop run. */
  async idle() {
    for (let index = 0; index < 10; index++) await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export type Answer = HostStepStart;

interface HostCall {
  readonly method: "step" | "settled" | "timedOut" | "failed" | "finish";
  readonly runId: string;
  readonly key?: string;
  readonly request?: StepRequest;
  readonly error?: string;
  readonly end?: RunEnd;
  readonly marks?: Marks;
}

/** An `AutomationRunHost` that answers steps from `answer` and records every call. */
export class FakeHost implements AutomationRunHost {
  readonly calls: HostCall[] = [];
  private readonly upserted = new Map<string, unknown>();
  private readonly answer: (
    request: StepRequest,
    runId: string,
  ) => HostStepStart | Promise<HostStepStart>;
  private readonly late: (key: string) => Settlement;

  constructor(
    answer: (request: StepRequest, runId: string) => HostStepStart | Promise<HostStepStart>,
    late: (key: string) => Settlement = () => ({ ok: false, error: "Timed out" }),
  ) {
    this.answer = answer;
    this.late = late;
  }

  async step(runId: string, request: StepRequest, marks: Marks) {
    this.calls.push({ method: "step", runId, request, marks });
    const start = await this.answer(request, runId);
    for (const [key, value] of marks) this.upserted.set(`${runId}:${key}`, value);
    return start;
  }

  async settled(runId: string, key: string) {
    this.calls.push({ method: "settled", runId, key });
  }

  async timedOut(runId: string, key: string) {
    this.calls.push({ method: "timedOut", runId, key });
    return this.late(key);
  }

  async failed(runId: string, key: string, error: string) {
    this.calls.push({ method: "failed", runId, key, error });
  }

  async finish(runId: string, end: RunEnd, marks: Marks) {
    this.calls.push({ method: "finish", runId, end, marks });
    for (const [key, value] of marks) this.upserted.set(`${runId}:${key}`, value);
  }

  /** Keys of every `step` call, in order. */
  stepKeys(runId?: string) {
    return this.calls
      .filter((call) => call.method === "step" && (runId === undefined || call.runId === runId))
      .map((call) => call.request!.key);
  }

  of(method: HostCall["method"]) {
    return this.calls.filter((call) => call.method === method);
  }

  finished() {
    return this.of("finish").map(({ end, marks }) => ({ end, marks }));
  }

  /** The marks the host holds for `runId` (default "run-1"), upserted by key. */
  marks(runId = "run-1") {
    const prefix = `${runId}:`;
    return new Map(
      [...this.upserted]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => [key.slice(prefix.length), value]),
    );
  }
}

/** The event the dispatcher passes to `AutomationRun.run`. */
export const payload = (runId: string, input: unknown = null, trigger: unknown = null) => ({
  payload: { runId, input, trigger },
});

type Verb = (site: string, label: string, ...args: unknown[]) => Promise<unknown>;

/** The `w` receiver as compiled automations call it. */
export interface Receiver {
  readonly agent: Verb;
  readonly call: Verb;
  readonly http: Verb;
  readonly run: Verb;
  readonly llm: Verb;
  readonly judge: Verb;
  readonly extract: Verb;
  readonly ask: Verb;
  readonly notify: Verb;
  readonly sleep: Verb;
  readonly waitFor: Verb;
  readonly hook: Verb;
  readonly recall: Verb;
  readonly remember: Verb;
  readonly start: Verb;
  when(site: string, label: string, condition: unknown): boolean;
  $arm(site: string, index: number): void;
  done(value?: unknown): unknown;
  restart(input?: unknown): unknown;
  $frame(site: string): Receiver;
  each(
    site: string,
    label: string,
    items: Iterable<unknown>,
    ...rest:
      | [(w: Receiver, item: unknown, index: number) => Promise<unknown>]
      | [{ concurrency?: number }, (w: Receiver, item: unknown, index: number) => Promise<unknown>]
  ): Promise<unknown[]>;
  repeat(
    site: string,
    label: string,
    options: { max: number },
    fn: (w: Receiver, attempt: number) => Promise<unknown>,
  ): Promise<{ done: boolean; value?: unknown; attempts: number }>;
  parallel(
    site: string,
    label: string,
    branches: Record<string, (w: Receiver) => Promise<unknown>>,
  ): Promise<Record<string, unknown>>;
}
