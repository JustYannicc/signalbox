// @effect-diagnostics cryptoRandomUUID:off - throwaway values stay inside this isolated test.
import { secretPlaceholder } from "@signalbox/runner-protocol/SecretScrubber";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";

import { ThreadStore } from "./ThreadStore.ts";
import { serveWithFakeNetwork } from "./tests/egressTestKit.ts";
import {
  connect,
  freshDatabase,
  launch,
  liveTurn,
  owner,
  personal,
  threadId,
  turnReport,
  withObject,
} from "./runnerTesting.ts";

const historical = `search-old-${crypto.randomUUID()}`;
const current = `search-current-${crypto.randomUUID()}`;
const placeholder = secretPlaceholder("KEY");

it.effect("keeps registered secret echoes out of live search delivery and backfill", () =>
  withObject(freshDatabase(), (engine, runner, context) =>
    Effect.gen(function* () {
      yield* launch(engine, "search-secret-echo", personal);
      const machine = yield* connect(runner);
      const turn = yield* liveTurn(runner);
      const token = (yield* runner.work).sessions?.token;
      if (token === undefined) throw new Error("expected the Runner session token");

      const registration = yield* runner.registerSecrets(token, {
        runId: turn.runId,
        secrets: [
          { name: "KEY", value: historical },
          { name: "KEY", value: current },
        ],
        current: [{ name: "KEY", value: current }],
      });
      expect(registration._tag).toBe("registered");

      const secrets = yield* Context.get(context, ThreadStore).secretValues;
      const response = yield* Effect.promise(() =>
        serveWithFakeNetwork(
          new Request("https://approved.example/echo", {
            method: "POST",
            headers: { "content-type": "text/plain" },
            body: placeholder,
          }),
          {
            ownHosts: new Set(),
            thread: {
              secrets: async () => secrets,
              authorize: async () => ({ _tag: "allowed" }),
            },
            send: async () =>
              new Response(`${historical}\n${current}`, {
                headers: { "content-type": "text/plain" },
              }),
          },
        ),
      );
      const echo = yield* Effect.promise(() => response.text());
      const report = turnReport(turn.runId, turn.runOrdinal, turn.providerThread, {
        replyText: echo,
      });
      yield* runner.batch({
        generation: machine.generation,
        sequence: 1,
        items: [report.started, report.full, report.terminal],
      });

      const drain = (limit: number) =>
        Effect.gen(function* () {
          let serialized = "";
          let count = 0;
          let finalBackfillPage = false;
          for (; count < limit; count += 1) {
            const delivery = yield* engine.pendingSearchDelivery;
            if (delivery === null) return { serialized, count, finalBackfillPage };
            serialized += JSON.stringify(delivery);
            finalBackfillPage = delivery.snapshot?.final === true;
            yield* engine.acknowledgeSearchDelivery(delivery.revision, delivery.deliveryId);
          }
          throw new Error("search delivery exceeded the bounded test queue");
        });

      const live = yield* drain(16);
      const activation = `search-backfill:${threadId}:secret-echo`;
      const backfillStarted = yield* engine.backfill(owner, activation);
      expect(backfillStarted).not.toBeNull();
      const backfill = yield* drain(16);

      for (const delivered of [live, backfill]) {
        expect(delivered.count).toBeGreaterThan(0);
        expect(delivered.serialized.includes(placeholder)).toBe(true);
        expect(delivered.serialized.includes(historical)).toBe(false);
        expect(delivered.serialized.includes(current)).toBe(false);
      }
      expect(backfill.finalBackfillPage).toBe(true);
    }),
  ),
);
