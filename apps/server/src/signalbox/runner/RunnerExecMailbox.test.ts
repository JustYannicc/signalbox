import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";

import type { ExecReport } from "@signalbox/runner-protocol/ExecProtocol";

import { RunnerExecMailbox } from "./RunnerExecMailbox.ts";

it.effect(
  "backpressures output and keeps acknowledgements, exit and closed reports past high water",
  () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<ExecReport, Cause.Done>();
      const mailbox = new RunnerExecMailbox(queue);
      const resumed = yield* Deferred.make<void>();
      let pauseCount = 0;
      let resumeCount = 0;
      const source = {
        pause: () => {
          pauseCount += 1;
        },
        resume: () => {
          resumeCount += 1;
          Deferred.doneUnsafe(resumed, Effect.void);
        },
      };
      const output = Array.from({ length: 256 }, (_, index): ExecReport => ({
        type: "output",
        generation: 1,
        processId: "process-1",
        sequence: index + 1,
        stream: "stdout",
        dataBase64: "AA==",
      }));
      for (const report of output) mailbox.offer(report, source);
      mailbox.offer({
        type: "ack",
        generation: 1,
        processId: "process-1",
        operation: "start",
        requestId: "start-1",
        applied: true,
      });
      mailbox.offer({
        type: "exit",
        generation: 1,
        processId: "process-1",
        sequence: 257,
        exitCode: 0,
      });
      mailbox.offer({
        type: "closed",
        generation: 1,
        processId: "process-1",
        sequence: 258,
      });

      expect(Queue.sizeUnsafe(queue)).toBe(259);
      expect(pauseCount).toBe(1);
      const collected = yield* Deferred.make<ReadonlyArray<ExecReport>>();
      yield* Stream.runCollect(mailbox.stream).pipe(
        Effect.flatMap((reports) => Deferred.succeed(collected, reports)),
        Effect.forkScoped,
      );
      yield* Deferred.await(resumed);
      mailbox.close();

      const reports = yield* Deferred.await(collected);
      expect(resumeCount).toBe(1);
      expect(reports).toHaveLength(259);
      expect(reports[256]).toMatchObject({ type: "ack", requestId: "start-1", applied: true });
      expect(reports[257]).toMatchObject({ type: "exit", sequence: 257 });
      expect(reports[258]).toMatchObject({ type: "closed", sequence: 258 });
    }),
);

it.effect("resumes paused output sources when the mailbox closes", () =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ExecReport, Cause.Done>();
    const mailbox = new RunnerExecMailbox(queue);
    let pauseCount = 0;
    let resumeCount = 0;
    const source = {
      pause: () => {
        pauseCount += 1;
      },
      resume: () => {
        resumeCount += 1;
      },
    };

    for (let sequence = 1; sequence <= 256; sequence += 1) {
      mailbox.offer(
        {
          type: "output",
          generation: 1,
          processId: "process-1",
          sequence,
          stream: "stdout",
          dataBase64: "AA==",
        },
        source,
      );
    }

    expect(pauseCount).toBe(1);
    mailbox.close();
    expect(resumeCount).toBe(1);
  }),
);
