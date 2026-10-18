import { COLLABORATION_TOOLS } from "@t3tools/contracts/signalboxCollaboration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Tool from "effect/ai/Tool";

import { automationCaller } from "./RunnerAutomationTools.ts";
import { json, register } from "./RunnerContextTools.ts";
import type { DrivesView } from "./RunnerDrivesView.ts";

/** Thin MCP transport; cloud services authorize and execute every call. */
export const layerThreadTools = (view: DrivesView) => {
  const ask = automationCaller(view);
  return Layer.effectDiscard(
    Effect.forEach(
      Object.entries(COLLABORATION_TOOLS),
      ([name, tool]) =>
        register({
          name,
          description: tool.summary,
          parameters: name === "orchestrator_capabilities" ? Tool.EmptyParams : tool.input,
          ...(tool.writes ? { writes: tool.writes } : {}),
          handle: (input) => ask(name, input, !tool.writes).pipe(Effect.map(json)),
        }),
      { discard: true },
    ),
  );
};
