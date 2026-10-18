import { SIGNALBOX_ASK_TOOLS } from "@t3tools/contracts/signalboxAskTools";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { answer, automationCaller } from "./RunnerAutomationTools.ts";
import { badArguments, register } from "./RunnerContextTools.ts";
import type { DrivesView } from "./RunnerDrivesView.ts";

export const layerAskTools = (view: DrivesView) => {
  const call = automationCaller(view);
  return Layer.effectDiscard(
    Effect.all(
      Object.entries(SIGNALBOX_ASK_TOOLS).map(([name, declaration]) => {
        const encode = Schema.encodeUnknownEffect(declaration.parameters);
        return register({
          name,
          description: declaration.description,
          parameters: declaration.parameters,
          ...(declaration.readonly ? {} : { writes: { destructive: false, openWorld: false } }),
          handle: (input) =>
            encode(input).pipe(
              Effect.mapError(badArguments),
              Effect.flatMap((encoded) => call(name, encoded, declaration.readonly)),
              Effect.map(answer),
            ),
        });
      }),
    ),
  );
};
