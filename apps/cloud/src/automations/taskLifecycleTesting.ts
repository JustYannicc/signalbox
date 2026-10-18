import * as WorkflowEngine from "@signalbox/automations/WorkflowEngine";
import * as Effect from "effect/Effect";

import type { makeMemoryCloud } from "../testing.ts";
import { scriptedModelSelection } from "../thread/scriptedProvider.ts";

// These fixtures test other services without running the task evaluator's model turns.
export const pauseTaskDone = (
  cloud: ReturnType<typeof makeMemoryCloud>,
  userId: string,
  projectId: string,
) =>
  cloud.inUser(
    userId,
    WorkflowEngine.WorkflowEngine.use((engine) =>
      Effect.gen(function* () {
        const automation = yield* engine.customize("builtin:task-done", {
          projectId,
          defaults: {
            modelSelection: scriptedModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
          },
        });
        yield* engine.setEnabled(automation.id, false);
      }),
    ),
  );
