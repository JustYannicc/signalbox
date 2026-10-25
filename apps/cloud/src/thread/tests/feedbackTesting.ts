import { ProviderDriverKind, ProviderInstanceId, ProviderSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { connect, launch, liveTurn, personal, turnReport, withObject } from "../runnerTesting.ts";

export const codex = { instanceId: ProviderInstanceId.make("codex_hub"), model: "gpt-6.1" };
const driver = ProviderDriverKind.make("codex");

export const startCodex = (
  engine: Parameters<Parameters<typeof withObject>[1]>[0],
  runner: Parameters<Parameters<typeof withObject>[1]>[1],
) =>
  Effect.gen(function* () {
    yield* launch(engine, "launch", personal, { modelSelection: codex });
    const machine = yield* connect(runner);
    const turn = yield* liveTurn(runner);
    const original = turnReport(turn.runId, turn.runOrdinal, turn.providerThread).started;
    const providerThread = {
      ...turn.providerThread,
      providerSessionId: ProviderSessionId.make("codex-session"),
      nativeThreadRef: { driver, nativeId: "native-codex", strength: "strong" as const },
    };
    yield* runner.batch({
      generation: machine.generation,
      sequence: 1,
      items: [
        {
          ...original,
          providerThread,
          providerSession: {
            ...original.providerSession,
            id: ProviderSessionId.make("codex-session"),
            driver,
            providerInstanceId: codex.instanceId,
          },
        },
      ],
    });
    return { machine, providerThread };
  });
