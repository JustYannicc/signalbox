import { CommandId, EventId, ProjectId } from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID } from "@t3tools/contracts/signalboxContexts";
import type { TerminalSessionSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type * as ThreadEngine from "../ThreadEngine.ts";
import {
  claude,
  connect,
  freshDatabase,
  hello,
  launch,
  liveTurn,
  owner,
  personal,
  threadId,
  turnReport,
  withObject,
} from "../runnerTesting.ts";
import * as TerminalTesting from "../TerminalTesting.ts";

type TerminalTestServices = ReturnType<typeof TerminalTesting.terminalTestServices>;

const input = {
  threadId,
  terminalId: "term-1",
  cwd: "/ignored/client/path",
  cols: 104,
  rows: 31,
  env: { T3CODE_PROJECT_ROOT: "/ignored/client/path", CUSTOM_FLAG: "1" },
};

const setup = <A, E>(
  use: (services: TerminalTestServices) => Effect.Effect<A, E>,
  options: { readonly drives?: boolean } = {},
) =>
  withObject(
    freshDatabase(),
    (engine, runner, context) =>
      Effect.gen(function* () {
        yield* launch(engine);
        const first = yield* connect(runner);
        const turn = yield* liveTurn(runner);
        const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread);
        yield* runner.batch({
          generation: first.generation,
          sequence: 1,
          items: [report.started, report.full, report.terminal],
        });
        yield* runner.ended(first.generation, "turn complete");
        return yield* use(TerminalTesting.terminalTestServices(context));
      }),
    { drives: options.drives ?? true },
  );

const setupBeforeMachine = <A, E>(use: (services: TerminalTestServices) => Effect.Effect<A, E>) =>
  withObject(
    freshDatabase(),
    (engine, runner, context) =>
      Effect.gen(function* () {
        yield* launch(engine);
        return yield* use(TerminalTesting.terminalTestServices(context));
      }),
    { drives: true },
  );

const opened = (snapshot: TerminalSessionSnapshot) => ({
  type: "opened" as const,
  snapshot: { ...snapshot, status: "running" as const, pid: 100, sequence: 0 },
});

const generationOf = (snapshot: TerminalSessionSnapshot) => {
  if (snapshot.generation === undefined) throw new Error("expected a terminal generation");
  return snapshot.generation;
};

const createIdleThread = (engine: ThreadEngine.ThreadEngine["Service"]) =>
  engine.dispatch(
    owner,
    {
      type: "thread.create",
      commandId: CommandId.make("create-idle-terminal-thread"),
      createdBy: "user",
      creationSource: "web",
      threadId,
      projectId: ProjectId.make("scratch"),
      title: "Terminal test",
      modelSelection: claude,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    },
    personal,
  );

const setupIdleThread = <A, E>(use: (services: TerminalTestServices) => Effect.Effect<A, E>) =>
  withObject(
    freshDatabase(),
    (engine, _runner, context) =>
      Effect.gen(function* () {
        yield* createIdleThread(engine);
        return yield* use(TerminalTesting.terminalTestServices(context));
      }),
    { drives: true },
  );

const markDeleted = (engine: ThreadEngine.ThreadEngine["Service"]) =>
  Effect.gen(function* () {
    const projection = yield* engine.projection;
    if (projection === null) throw new Error("expected a thread projection");
    const deletedAt = DateTime.makeUnsafe("2026-10-17T00:00:00.000Z");
    yield* engine.apply(() =>
      Effect.succeed({
        events: [
          {
            id: EventId.make("thread-delete"),
            threadId,
            occurredAt: deletedAt,
            type: "thread.deleted",
            payload: { ...projection.thread, updatedAt: deletedAt, deletedAt },
          },
        ],
        result: undefined,
      }),
    );
  });

describe("cloud thread terminals", () => {
  it.effect("wakes a machine with no active turn and opens in its drive workspace", () =>
    setup(({ terminals, runner }) =>
      Effect.gen(function* () {
        expect((yield* runner.work).turn).toBeNull();
        expect(yield* terminals.held).toBe(false);
        const initial = yield* terminals.open(owner, input);
        expect(initial).toMatchObject({
          terminalId: "term-1",
          cwd: "/scratch",
          status: "starting",
        });
        expect(yield* terminals.held).toBe(true);
        const plan = yield* runner.reconcile;
        expect(plan.ensure).not.toBeNull();
        if (plan.ensure === null) throw new Error("expected a terminal machine");
        yield* runner.ensured(plan.ensure.generation);
        const welcome = yield* runner.hello(hello(plan.ensure.generation, plan.ensure.token));
        if (welcome._tag !== "welcome") throw new Error("expected a welcome");
        yield* terminals.connected(plan.ensure.generation, "process-one");
        const commands = yield* terminals.work(plan.ensure.generation);
        expect(commands).toHaveLength(1);
        expect(commands[0]?.command).toMatchObject({
          type: "open",
          terminalId: "term-1",
          cols: 104,
          rows: 31,
          drive: { driveId: "my/personal/user_1" },
          env: { CUSTOM_FLAG: "1" },
        });
        expect(JSON.stringify(commands[0])).not.toContain("/ignored/client/path");
        const drive = commands[0]?.command.type === "open" ? commands[0].command.drive : null;
        expect(drive?.remoteToken).toMatch(/^sbr1\./);
        if (drive?.remoteToken === null || drive === null) throw new Error("expected remote token");
        expect((yield* runner.authorizeRemote(drive.remoteToken))._tag).toBe("granted");
        const stream = yield* terminals.observe(owner, { threadId, terminalId: "term-1" });
        const firstSeen = yield* Deferred.make<void>();
        const collected = yield* Stream.runCollect(
          Stream.take(
            Stream.tap(stream, (event) =>
              event.type === "snapshot" ? Deferred.succeed(firstSeen, undefined) : Effect.void,
            ),
            3,
          ),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(firstSeen);
        yield* terminals.report(plan.ensure.generation, welcome.connection, {
          type: "result",
          requestId: commands[0]!.requestId,
          terminalId: "term-1",
          generation: 1,
          leaseGeneration: plan.ensure.generation,
          result: opened(initial),
        });
        yield* terminals.report(plan.ensure.generation, welcome.connection, {
          type: "event",
          terminalId: "term-1",
          generation: 1,
          leaseGeneration: plan.ensure.generation,
          sequence: 1,
          event: { type: "output", data: "ready> " },
        });
        const fresh = yield* terminals.observe(owner, { threadId, terminalId: "term-1" });
        expect(Option.getOrThrow(yield* Stream.runHead(fresh))).toMatchObject({
          type: "snapshot",
          snapshot: { status: "running", history: "ready> ", sequence: 3 },
        });
        expect((yield* Fiber.join(collected)).map((event) => event.type)).toEqual([
          "snapshot",
          "snapshot",
          "output",
        ]);
        const current = yield* terminals.observe(owner, { threadId, terminalId: "term-1" });
        expect(Option.getOrThrow(yield* Stream.runHead(current))).toMatchObject({
          type: "snapshot",
          snapshot: { history: "ready> ", sequence: 3 },
        });
        expect((yield* terminals.work(plan.ensure.generation)).length).toBe(0);
        expect(yield* terminals.held).toBe(true);
        yield* terminals.close(owner, { threadId, terminalId: "term-1" });
        expect(yield* terminals.held).toBe(true);
        yield* terminals.close(owner, { threadId, terminalId: "term-1" });
        yield* terminals.report(plan.ensure.generation, welcome.connection, {
          type: "event",
          terminalId: "term-1",
          generation: 1,
          leaseGeneration: plan.ensure.generation,
          sequence: 3,
          event: { type: "output", data: "after a gap while closing" },
        });
        expect(yield* terminals.held).toBe(true);
        const close = yield* terminals.work(plan.ensure.generation);
        expect(close.map(({ command }) => command.type)).toEqual(["close"]);
        yield* terminals.report(plan.ensure.generation, welcome.connection, {
          type: "result",
          requestId: close[0]!.requestId,
          terminalId: "term-1",
          generation: 1,
          leaseGeneration: plan.ensure.generation,
          result: { type: "closed" },
        });
        expect(yield* terminals.held).toBe(false);
      }),
    ),
  );

  it.effect("denies another actor and never starts a terminal for observe", () =>
    setup(({ terminals, runner }) =>
      Effect.gen(function* () {
        const stranger = { userId: "other", contextIds: [PERSONAL_CONTEXT_ID] };
        expect((yield* Effect.flip(terminals.open(stranger, input)))._tag).toBe(
          "ThreadNotFoundError",
        );
        expect(
          (yield* Effect.flip(terminals.observe(owner, { threadId, terminalId: "term-1" })))._tag,
        ).toBe("TerminalSessionLookupError");
        expect(yield* terminals.held).toBe(false);
        expect((yield* runner.reconcile).ensure).toBeNull();
      }),
    ),
  );

  it.effect("does not start a terminal when this cloud has no drive storage", () =>
    setup(
      ({ terminals }) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(terminals.open(owner, input));
          expect(failure).toMatchObject({
            _tag: "TerminalOperationError",
            operation: "open",
            reason: "unavailable",
          });
          expect(yield* terminals.held).toBe(false);
        }),
      { drives: false },
    ),
  );

  it.effect("queues generation-fenced input until the terminal open is acknowledged", () =>
    setupBeforeMachine(({ terminals, runner }) =>
      Effect.gen(function* () {
        const initial = yield* terminals.open(owner, input);
        const generation = generationOf(initial);
        const earlyInput = {
          threadId,
          terminalId: input.terminalId,
          generation,
          commandId: "before-machine",
          data: "echo queued",
        };
        const missingGeneration = yield* Effect.flip(
          terminals.write(owner, { ...earlyInput, generation: undefined }),
        );
        expect(missingGeneration).toMatchObject({
          _tag: "TerminalOperationError",
          reason: "generation_required",
        });
        yield* terminals.write(owner, earlyInput);

        const machine = yield* connect(runner);
        const welcome = yield* runner.hello(hello(machine.generation, machine.token));
        if (welcome._tag !== "welcome") throw new Error("expected a welcome");
        yield* terminals.connected(machine.generation, "process-one");
        const opening = yield* terminals.work(machine.generation);
        expect(opening).toHaveLength(1);
        expect(opening[0]?.command).toMatchObject({ type: "open", generation });

        yield* terminals.report(machine.generation, welcome.connection, {
          type: "result",
          requestId: opening[0]!.requestId,
          terminalId: input.terminalId,
          generation,
          leaseGeneration: machine.generation,
          result: opened(initial),
        });
        const writing = yield* terminals.work(machine.generation);
        expect(writing).toHaveLength(1);
        expect(writing[0]?.command).toMatchObject({
          type: "write",
          generation,
          commandId: "before-machine",
          data: "echo queued",
        });
        yield* terminals.report(machine.generation, welcome.connection, {
          type: "result",
          requestId: writing[0]!.requestId,
          terminalId: input.terminalId,
          generation,
          leaseGeneration: machine.generation,
          commandId: "before-machine",
          result: { type: "written" },
        });
        yield* terminals.write(owner, earlyInput);
        expect(yield* terminals.work(machine.generation)).toEqual([]);
      }),
    ),
  );

  it.effect("reconciles a deleted unbound terminal without starting a machine", () =>
    withObject(
      freshDatabase(),
      (engine, _runner, context) =>
        Effect.gen(function* () {
          yield* createIdleThread(engine);
          const { terminals, runner, store } = TerminalTesting.terminalTestServices(context);
          const initial = yield* terminals.open(owner, input);
          yield* terminals.write(owner, {
            threadId,
            terminalId: input.terminalId,
            generation: generationOf(initial),
            commandId: "queued-before-machine",
            data: "echo discarded",
          });

          yield* markDeleted(engine);
          yield* terminals.reconcile;

          expect(yield* store.get(input.terminalId)).toMatchObject({ status: "closed" });
          expect(yield* store.byCommandId(input.terminalId, "queued-before-machine")).toMatchObject(
            { outcome: "abandoned", data: null },
          );
          expect(yield* terminals.held).toBe(false);
          expect((yield* runner.reconcile).ensure).toBeNull();
        }),
      { drives: true },
    ),
  );

  it.effect("closes held terminals after thread deletion and denies later opens and attaches", () =>
    setupBeforeMachine(({ terminals, runner, engine }) =>
      Effect.gen(function* () {
        const initial = yield* terminals.open(owner, input);
        const machine = yield* connect(runner);
        const welcome = yield* runner.hello(hello(machine.generation, machine.token));
        if (welcome._tag !== "welcome") throw new Error("expected a welcome");
        yield* terminals.connected(machine.generation, "process-one");
        const opening = (yield* terminals.work(machine.generation))[0]!;
        yield* terminals.report(machine.generation, welcome.connection, {
          type: "result",
          requestId: opening.requestId,
          terminalId: input.terminalId,
          generation: generationOf(initial),
          leaseGeneration: machine.generation,
          result: opened(initial),
        });

        yield* markDeleted(engine);
        yield* terminals.reconcile;
        expect((yield* Effect.flip(terminals.open(owner, input)))._tag).toBe("ThreadNotFoundError");
        expect(
          (yield* Effect.flip(terminals.attach(owner, { threadId, terminalId: input.terminalId })))
            ._tag,
        ).toBe("ThreadNotFoundError");
        expect(yield* terminals.held).toBe(true);

        const closing = yield* terminals.work(machine.generation);
        expect(closing).toHaveLength(1);
        expect(closing[0]?.command).toMatchObject({
          type: "close",
          generation: generationOf(initial),
        });
        yield* terminals.report(machine.generation, welcome.connection, {
          type: "result",
          requestId: closing[0]!.requestId,
          terminalId: input.terminalId,
          generation: generationOf(initial),
          leaseGeneration: machine.generation,
          result: { type: "closed" },
        });
        expect(yield* terminals.held).toBe(false);
      }),
    ),
  );

  it.effect("replaces a terminal still closing through a higher-generation runner open", () =>
    setupBeforeMachine(({ terminals, runner }) =>
      Effect.gen(function* () {
        const initial = yield* terminals.open(owner, input);
        const machine = yield* connect(runner);
        const welcome = yield* runner.hello(hello(machine.generation, machine.token));
        if (welcome._tag !== "welcome") throw new Error("expected a welcome");
        yield* terminals.connected(machine.generation, "process-one");
        const opening = (yield* terminals.work(machine.generation))[0]!;
        yield* terminals.report(machine.generation, welcome.connection, {
          type: "result",
          requestId: opening.requestId,
          terminalId: input.terminalId,
          generation: generationOf(initial),
          leaseGeneration: machine.generation,
          result: opened(initial),
        });
        yield* terminals.close(owner, { threadId, terminalId: input.terminalId });
        expect(yield* terminals.held).toBe(true);

        const replacement = yield* terminals.restart(owner, input);
        expect(replacement.generation).toBe(generationOf(initial) + 1);
        const work = yield* terminals.work(machine.generation);
        expect(work).toHaveLength(1);
        expect(work[0]?.command).toMatchObject({
          type: "open",
          generation: generationOf(replacement),
        });
        yield* terminals.report(machine.generation, welcome.connection, {
          type: "result",
          requestId: work[0]!.requestId,
          terminalId: input.terminalId,
          generation: generationOf(replacement),
          leaseGeneration: machine.generation,
          result: opened(replacement),
        });
        expect(yield* terminals.held).toBe(true);
      }),
    ),
  );

  it.effect("plain open starts a new generation instead of returning a closing snapshot", () =>
    setupBeforeMachine(({ terminals, runner }) =>
      Effect.gen(function* () {
        const initial = yield* terminals.open(owner, input);
        const machine = yield* connect(runner);
        const welcome = yield* runner.hello(hello(machine.generation, machine.token));
        if (welcome._tag !== "welcome") throw new Error("expected a welcome");
        yield* terminals.connected(machine.generation, "process-one");
        const opening = (yield* terminals.work(machine.generation))[0]!;
        yield* terminals.report(machine.generation, welcome.connection, {
          type: "result",
          requestId: opening.requestId,
          terminalId: input.terminalId,
          generation: generationOf(initial),
          leaseGeneration: machine.generation,
          result: opened(initial),
        });
        yield* terminals.close(owner, { threadId, terminalId: input.terminalId });
        expect(yield* terminals.held).toBe(true);

        const replacement = yield* terminals.open(owner, input);
        expect(replacement.status).toBe("starting");
        expect(replacement.generation).toBe(generationOf(initial) + 1);
        const work = yield* terminals.work(machine.generation);
        expect(work).toHaveLength(1);
        expect(work[0]?.command).toMatchObject({
          type: "open",
          generation: generationOf(replacement),
        });
      }),
    ),
  );

  it.effect(
    "deduplicates input, replays one pending request after reconnect, and ignores stale reports",
    () =>
      setup(({ terminals, runner }) =>
        Effect.gen(function* () {
          const initial = yield* terminals.open(owner, input);
          const machine = yield* connect(runner);
          const welcome = yield* runner.hello(hello(machine.generation, machine.token));
          if (welcome._tag !== "welcome") throw new Error("expected a welcome");
          yield* terminals.connected(machine.generation, "process-one");
          const open = (yield* terminals.work(machine.generation))[0]!;
          yield* terminals.report(machine.generation, welcome.connection, {
            type: "result",
            requestId: open.requestId,
            terminalId: "term-1",
            generation: 1,
            leaseGeneration: machine.generation,
            result: opened(initial),
          });
          yield* terminals.write(owner, {
            threadId,
            terminalId: "term-1",
            generation: generationOf(initial),
            commandId: "input-1",
            data: "a",
          });
          yield* terminals.write(owner, {
            threadId,
            terminalId: "term-1",
            generation: generationOf(initial),
            commandId: "input-1",
            data: "a",
          });
          expect(
            (yield* Effect.flip(
              terminals.write(owner, {
                threadId,
                terminalId: "term-1",
                generation: generationOf(initial),
                commandId: "input-1",
                data: "b",
              }),
            ))._tag,
          ).toBe("TerminalOperationError");
          const pending = yield* terminals.work(machine.generation);
          expect(pending).toHaveLength(1);
          expect(pending[0]?.command).toMatchObject({
            type: "write",
            commandId: "input-1",
            data: "a",
          });
          const reconnected = yield* runner.hello(hello(machine.generation, machine.token));
          if (reconnected._tag !== "welcome") throw new Error("expected a welcome");
          yield* terminals.connected(machine.generation, "process-one");
          expect((yield* terminals.work(machine.generation))[0]?.requestId).toBe(
            pending[0]?.requestId,
          );
          const result = {
            type: "result" as const,
            requestId: pending[0]!.requestId,
            terminalId: "term-1",
            generation: 1,
            leaseGeneration: machine.generation,
            commandId: "input-1",
            result: { type: "written" as const },
          };
          yield* terminals.report(machine.generation, welcome.connection, result);
          expect((yield* terminals.work(machine.generation)).length).toBe(1);
          yield* terminals.report(machine.generation, reconnected.connection, result);
          expect((yield* terminals.work(machine.generation)).length).toBe(0);
          yield* terminals.report(machine.generation, reconnected.connection, {
            type: "event",
            terminalId: "term-1",
            generation: 1,
            leaseGeneration: machine.generation,
            sequence: 1,
            event: { type: "output", data: "hello" },
          });
          yield* terminals.report(machine.generation, reconnected.connection, {
            type: "event",
            terminalId: "term-1",
            generation: 1,
            leaseGeneration: machine.generation,
            sequence: 1,
            event: { type: "output", data: "hello" },
          });
          const stream = yield* terminals.observe(owner, { threadId, terminalId: "term-1" });
          expect(Option.getOrThrow(yield* Stream.runHead(stream))).toMatchObject({
            type: "snapshot",
            snapshot: { history: "hello", sequence: 3 },
          });
        }),
      ),
  );

  it.effect("shows a lost PTY after a Runner process restart and keeps its output history", () =>
    setup(({ terminals, runner }) =>
      Effect.gen(function* () {
        const initial = yield* terminals.open(owner, input);
        const machine = yield* connect(runner);
        const welcome = yield* runner.hello(hello(machine.generation, machine.token));
        if (welcome._tag !== "welcome") throw new Error("expected a welcome");
        yield* terminals.connected(machine.generation, "process-one");
        const open = (yield* terminals.work(machine.generation))[0]!;
        yield* terminals.report(machine.generation, welcome.connection, {
          type: "result",
          requestId: open.requestId,
          terminalId: "term-1",
          generation: 1,
          leaseGeneration: machine.generation,
          result: opened(initial),
        });
        yield* terminals.report(machine.generation, welcome.connection, {
          type: "event",
          terminalId: "term-1",
          generation: 1,
          leaseGeneration: machine.generation,
          sequence: 1,
          event: { type: "output", data: "before restart" },
        });
        const reconnected = yield* runner.hello(hello(machine.generation, machine.token));
        if (reconnected._tag !== "welcome") throw new Error("expected a welcome");
        yield* terminals.connected(machine.generation, "process-two");
        expect(yield* terminals.held).toBe(false);
        expect(yield* terminals.work(machine.generation)).toEqual([]);
        const stream = yield* terminals.observe(owner, { threadId, terminalId: "term-1" });
        expect(Option.getOrThrow(yield* Stream.runHead(stream))).toMatchObject({
          type: "snapshot",
          snapshot: { status: "error", history: "before restart" },
        });
        yield* terminals.report(machine.generation, reconnected.connection, {
          type: "event",
          terminalId: "term-1",
          generation: 1,
          leaseGeneration: machine.generation,
          sequence: 2,
          event: { type: "output", data: "stale" },
        });
        const after = yield* terminals.observe(owner, { threadId, terminalId: "term-1" });
        expect(Option.getOrThrow(yield* Stream.runHead(after))).toMatchObject({
          type: "snapshot",
          snapshot: { history: "before restart" },
        });
      }),
    ),
  );

  it.effect("marks a missing runner output sequence as incomplete", () =>
    setup(({ terminals, runner }) =>
      Effect.gen(function* () {
        const initial = yield* terminals.open(owner, input);
        const machine = yield* connect(runner);
        const welcome = yield* runner.hello(hello(machine.generation, machine.token));
        if (welcome._tag !== "welcome") throw new Error("expected a welcome");
        yield* terminals.connected(machine.generation, "process-one");
        const open = (yield* terminals.work(machine.generation))[0]!;
        yield* terminals.report(machine.generation, welcome.connection, {
          type: "result",
          requestId: open.requestId,
          terminalId: "term-1",
          generation: 1,
          leaseGeneration: machine.generation,
          result: opened(initial),
        });
        yield* terminals.report(machine.generation, welcome.connection, {
          type: "event",
          terminalId: "term-1",
          generation: 1,
          leaseGeneration: machine.generation,
          sequence: 2,
          event: { type: "output", data: "missing first chunk" },
        });
        expect(yield* terminals.held).toBe(true);
        const stream = yield* terminals.observe(owner, { threadId, terminalId: "term-1" });
        expect(Option.getOrThrow(yield* Stream.runHead(stream))).toMatchObject({
          type: "snapshot",
          snapshot: { status: "error", history: "" },
        });
        const restarted = yield* terminals.attach(owner, {
          threadId,
          terminalId: input.terminalId,
          restartIfNotRunning: true,
        });
        expect(Option.getOrThrow(yield* Stream.runHead(restarted))).toMatchObject({
          type: "snapshot",
          snapshot: { status: "starting", history: "" },
        });
        expect((yield* terminals.work(machine.generation))[0]?.command).toMatchObject({
          type: "open",
          generation: 2,
        });
      }),
    ),
  );

  it.effect("replaces a slow reader's skipped output with the current bounded snapshot", () =>
    setup(({ terminals, runner }) =>
      Effect.gen(function* () {
        const initial = yield* terminals.open(owner, input);
        const machine = yield* connect(runner);
        const welcome = yield* runner.hello(hello(machine.generation, machine.token));
        if (welcome._tag !== "welcome") throw new Error("expected a welcome");
        yield* terminals.connected(machine.generation, "process-one");
        const open = (yield* terminals.work(machine.generation))[0]!;
        yield* terminals.report(machine.generation, welcome.connection, {
          type: "result",
          requestId: open.requestId,
          terminalId: "term-1",
          generation: 1,
          leaseGeneration: machine.generation,
          result: opened(initial),
        });
        const observed = yield* terminals.observe(owner, { threadId, terminalId: "term-1" });
        const ready = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const collected = yield* observed.pipe(
          Stream.tap((event) =>
            event.type === "snapshot"
              ? Deferred.succeed(ready, undefined).pipe(Effect.andThen(Deferred.await(resume)))
              : Effect.void,
          ),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Deferred.await(ready);
        for (let sequence = 1; sequence <= 260; sequence++) {
          yield* terminals.report(machine.generation, welcome.connection, {
            type: "event",
            terminalId: "term-1",
            generation: 1,
            leaseGeneration: machine.generation,
            sequence,
            event: { type: "output", data: "x" },
          });
        }
        yield* Deferred.succeed(resume, undefined);
        const events = yield* Fiber.join(collected);
        expect(events).toMatchObject([
          { type: "snapshot", snapshot: { sequence: 2 } },
          { type: "snapshot", snapshot: { sequence: 262, history: "x".repeat(260) } },
        ]);
      }),
    ),
  );
  it.effect("resizes, clears, and replaces the process without replaying old input", () =>
    setup(({ terminals, runner, store }) =>
      Effect.gen(function* () {
        const initial = yield* terminals.open(owner, input);
        const machine = yield* connect(runner);
        const welcome = yield* runner.hello(hello(machine.generation, machine.token));
        if (welcome._tag !== "welcome") throw new Error("expected welcome");
        yield* terminals.connected(machine.generation, "one-process");
        const first = (yield* terminals.work(machine.generation))[0]!;
        yield* terminals.report(machine.generation, welcome.connection, {
          type: "result",
          requestId: first.requestId,
          terminalId: input.terminalId,
          generation: 1,
          leaseGeneration: machine.generation,
          result: opened(initial),
        });
        yield* terminals.resize(owner, {
          threadId,
          terminalId: input.terminalId,
          cols: 132,
          rows: 42,
        });
        yield* terminals.clear(owner, { threadId, terminalId: input.terminalId });
        const controls = yield* terminals.work(machine.generation);
        expect(controls.map(({ command }) => command.type)).toEqual(["resize", "clear"]);
        expect(controls[0]?.command).toMatchObject({ cols: 132, rows: 42 });
        for (const control of controls)
          yield* terminals.report(machine.generation, welcome.connection, {
            type: "result",
            requestId: control.requestId,
            terminalId: input.terminalId,
            generation: 1,
            leaseGeneration: machine.generation,
            result: { type: control.command.type === "resize" ? "resized" : "cleared" },
          });
        yield* terminals.report(machine.generation, welcome.connection, {
          type: "event",
          terminalId: input.terminalId,
          generation: 1,
          leaseGeneration: machine.generation,
          sequence: 1,
          event: { type: "output", data: "before clear" },
        });
        yield* terminals.report(machine.generation, welcome.connection, {
          type: "event",
          terminalId: input.terminalId,
          generation: 1,
          leaseGeneration: machine.generation,
          sequence: 2,
          event: { type: "cleared" },
        });
        const cleared = yield* terminals.observe(owner, { threadId, terminalId: input.terminalId });
        expect(Option.getOrThrow(yield* Stream.runHead(cleared))).toMatchObject({
          type: "snapshot",
          snapshot: { history: "" },
        });
        yield* terminals.write(owner, {
          threadId,
          terminalId: input.terminalId,
          generation: generationOf(initial),
          commandId: "uncertain-input",
          data: "never repeat",
        });
        const restart = yield* terminals.restart(owner, { ...input, cols: 132, rows: 42 });
        expect(restart.status).toBe("starting");
        expect(restart.history).toBe("");
        expect(yield* store.countCommands(input.terminalId)).toBe(0);
        const replacement = yield* terminals.work(machine.generation);
        expect(replacement).toHaveLength(1);
        expect(replacement[0]?.command).toMatchObject({
          type: "open",
          generation: 2,
          cols: 132,
          rows: 42,
        });
        yield* terminals.report(machine.generation, welcome.connection, {
          type: "event",
          terminalId: input.terminalId,
          generation: 1,
          leaseGeneration: machine.generation,
          sequence: 3,
          event: { type: "output", data: "old process" },
        });
        yield* terminals.report(machine.generation, welcome.connection, {
          type: "result",
          requestId: replacement[0]!.requestId,
          terminalId: input.terminalId,
          generation: 2,
          leaseGeneration: machine.generation,
          result: opened(restart),
        });
        const stale = yield* Effect.flip(
          terminals.write(owner, {
            threadId,
            terminalId: input.terminalId,
            generation: generationOf(initial),
            commandId: "uncertain-input",
            data: "never repeat",
          }),
        );
        expect(stale).toMatchObject({ _tag: "TerminalOperationError", reason: "stale_generation" });
        yield* terminals.write(owner, {
          threadId,
          terminalId: input.terminalId,
          generation: generationOf(restart),
          commandId: "uncertain-input",
          data: "never repeat",
        });
        const typed = yield* terminals.work(machine.generation);
        expect(typed).toHaveLength(1);
        expect(typed[0]?.command).toMatchObject({
          type: "write",
          generation: generationOf(restart),
          data: "never repeat",
        });
        yield* terminals.report(machine.generation, welcome.connection, {
          type: "result",
          requestId: typed[0]!.requestId,
          terminalId: input.terminalId,
          generation: generationOf(restart),
          leaseGeneration: machine.generation,
          commandId: "uncertain-input",
          result: { type: "written" },
        });
        yield* terminals.write(owner, {
          threadId,
          terminalId: input.terminalId,
          generation: generationOf(restart),
          commandId: "uncertain-input",
          data: "never repeat",
        });
        const current = yield* terminals.observe(owner, { threadId, terminalId: input.terminalId });
        expect(Option.getOrThrow(yield* Stream.runHead(current))).toMatchObject({
          type: "snapshot",
          snapshot: { history: "", status: "running" },
        });
        expect(yield* terminals.work(machine.generation)).toEqual([]);
      }),
    ),
  );

  it.effect(
    "heals replay overflow from a current snapshot without accepting stale or duplicated output",
    () =>
      setup(({ terminals, runner }) =>
        Effect.gen(function* () {
          const initial = yield* terminals.open(owner, input);
          const machine = yield* connect(runner);
          const welcome = yield* runner.hello(hello(machine.generation, machine.token));
          if (welcome._tag !== "welcome") throw new Error("expected welcome");
          yield* terminals.connected(machine.generation, "one-process");
          const first = (yield* terminals.work(machine.generation))[0]!;
          yield* terminals.report(machine.generation, welcome.connection, {
            type: "result",
            requestId: first.requestId,
            terminalId: input.terminalId,
            generation: 1,
            leaseGeneration: machine.generation,
            result: opened(initial),
          });
          const restored = {
            ...initial,
            status: "running" as const,
            pid: 100,
            history: "restored",
            sequence: 900,
          };
          yield* terminals.report(machine.generation, welcome.connection, {
            type: "snapshot",
            terminalId: input.terminalId,
            generation: 1,
            leaseGeneration: machine.generation,
            snapshot: restored,
          });
          yield* terminals.report(machine.generation, welcome.connection, {
            type: "snapshot",
            terminalId: input.terminalId,
            generation: 1,
            leaseGeneration: machine.generation,
            snapshot: { ...restored, history: "stale", sequence: 899 },
          });
          for (const sequence of [900, 901])
            yield* terminals.report(machine.generation, welcome.connection, {
              type: "event",
              terminalId: input.terminalId,
              generation: 1,
              leaseGeneration: machine.generation,
              sequence,
              event: { type: "output", data: "!" },
            });
          const current = yield* terminals.observe(owner, {
            threadId,
            terminalId: input.terminalId,
          });
          expect(Option.getOrThrow(yield* Stream.runHead(current))).toMatchObject({
            type: "snapshot",
            snapshot: { history: "restored!", status: "running" },
          });
        }),
      ),
  );

  it.effect("releases a timed-out terminal request and abandons its queued input", () =>
    setupIdleThread(({ terminals, runner, store }) =>
      Effect.gen(function* () {
        const initial = yield* terminals.open(owner, input);
        const generation = generationOf(initial);
        yield* terminals.write(owner, {
          threadId,
          terminalId: input.terminalId,
          generation,
          commandId: "queued-before-timeout",
          data: "echo queued",
        });

        const requested = yield* runner.reconcile;
        const requestedGeneration = requested.ensure?.generation;
        if (requestedGeneration === undefined) throw new Error("expected a machine request");
        yield* TestClock.adjust(TerminalTesting.CONNECT_TIMEOUT_MS + 1);
        yield* terminals.reconcile;
        const timedOut = yield* runner.reconcile;
        expect(timedOut.release).toBe(requestedGeneration);
        yield* terminals.lost(requestedGeneration);

        expect(yield* terminals.held).toBe(false);
        expect(yield* store.get(input.terminalId)).toMatchObject({
          leaseGeneration: requestedGeneration,
          status: "error",
          processLost: true,
        });
        expect(yield* store.byCommandId(input.terminalId, "queued-before-timeout")).toMatchObject({
          leaseGeneration: requestedGeneration,
          outcome: "abandoned",
          data: null,
        });
      }),
    ),
  );

  it.effect("does not lose a newer unbound terminal to an older released runner lease", () =>
    setupIdleThread(({ terminals, runner, store }) =>
      Effect.gen(function* () {
        yield* terminals.open(owner, input);
        const requested = yield* runner.reconcile;
        const requestedGeneration = requested.ensure?.generation;
        if (requestedGeneration === undefined) throw new Error("expected a machine request");
        yield* terminals.reconcile;
        expect(yield* store.get(input.terminalId)).toMatchObject({
          status: "starting",
          leaseGeneration: requestedGeneration,
        });
        yield* TestClock.adjust(TerminalTesting.CONNECT_TIMEOUT_MS + 1);
        const timedOut = yield* runner.reconcile;
        expect(timedOut.release).toBe(requestedGeneration);

        const newerInput = { ...input, terminalId: "term-2" };
        yield* terminals.open(owner, newerInput);
        yield* terminals.lost(requestedGeneration);
        yield* terminals.reconcile;

        expect(yield* store.get(input.terminalId)).toMatchObject({ status: "error" });
        expect(yield* store.get(newerInput.terminalId)).toMatchObject({
          status: "starting",
          leaseGeneration: 0,
        });
        expect(yield* terminals.held).toBe(true);
      }),
    ),
  );

  it.effect.each([false, true])(
    "releases terminals whose runner lease retired without a lost notification (closing: %s)",
    (closing) =>
      setupIdleThread(({ terminals, runner, store }) =>
        Effect.gen(function* () {
          const initial = yield* terminals.open(owner, input);
          const machine = yield* connect(runner);
          const welcome = yield* runner.hello(hello(machine.generation, machine.token));
          if (welcome._tag !== "welcome") throw new Error("expected a welcome");
          yield* terminals.connected(machine.generation, "retiring-process");
          const opening = (yield* terminals.work(machine.generation))[0]!;
          yield* terminals.report(machine.generation, welcome.connection, {
            type: "result",
            requestId: opening.requestId,
            terminalId: input.terminalId,
            generation: generationOf(initial),
            leaseGeneration: machine.generation,
            result: opened(initial),
          });
          yield* terminals.write(owner, {
            ...input,
            generation: generationOf(initial),
            commandId: "retired-input",
            data: "echo retired",
          });
          if (closing) yield* terminals.close(owner, input);
          yield* runner.ended(machine.generation, "retired without a terminal notification");
          if (closing) {
            const replacement = yield* runner.reconcile;
            expect(replacement.ensure?.generation).toBe(machine.generation + 1);
          }

          yield* terminals.reconcile;
          expect(yield* terminals.held).toBe(false);
          expect(yield* store.get(input.terminalId)).toMatchObject({
            status: closing ? "closed" : "error",
            processLost: true,
            pid: null,
          });
          expect(yield* store.pending(machine.generation)).toEqual([]);
          expect((yield* runner.reconcile).ensure).toBeNull();
        }),
      ),
  );

  it.effect.each(["close", "delete"] as const)(
    "%s releases a terminal bound to a machine that has not connected",
    (action) =>
      setupIdleThread(({ terminals, runner, store, engine }) =>
        Effect.gen(function* () {
          const initial = yield* terminals.open(owner, input);
          yield* terminals.write(owner, {
            ...input,
            generation: generationOf(initial),
            commandId: "cancelled-before-connect",
            data: "echo never run",
          });
          const requested = yield* runner.reconcile;
          const leaseGeneration = requested.ensure?.generation;
          if (leaseGeneration === undefined) throw new Error("expected a machine request");
          yield* terminals.reconcile;
          expect(yield* store.get(input.terminalId)).toMatchObject({ leaseGeneration });

          if (action === "close") yield* terminals.close(owner, input);
          else {
            yield* markDeleted(engine);
            yield* terminals.reconcile;
          }

          expect(yield* terminals.held).toBe(false);
          expect(yield* store.get(input.terminalId)).toMatchObject({
            status: "closed",
            pid: null,
          });
          expect(
            yield* store.byCommandId(input.terminalId, "cancelled-before-connect"),
          ).toMatchObject({
            outcome: "abandoned",
            data: null,
          });
          expect(yield* store.pending(leaseGeneration)).toEqual([]);
          expect((yield* runner.reconcile).ensure).toBeNull();
        }),
      ),
  );
});
