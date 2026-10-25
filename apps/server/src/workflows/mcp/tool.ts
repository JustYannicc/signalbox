import { OrchestratorMcpFailure } from "@t3tools/contracts";
import type * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";

/** Shared automation declarations; self-hosted handlers fail with the cloud-only outcome. */

export const tool = <
  Name extends string,
  P extends Schema.Struct.Fields = {},
  S extends Schema.Top = Schema.Top,
>(
  name: Name,
  options: {
    title: string;
    description: string;
    parameters?: Schema.Struct<P>;
    success: S;
    readonly: boolean;
    destructive?: boolean;
  },
) =>
  Tool.make(name, {
    description: options.description,
    // Tools without inputs leave parameters out, which publishes an empty object schema.
    ...(options.parameters ? { parameters: options.parameters } : {}),
    success: options.success,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
  })
    .annotate(Tool.Title, options.title)
    .annotate(Tool.Readonly, options.readonly)
    .annotate(Tool.Destructive, options.destructive ?? false)
    .annotate(Tool.OpenWorld, false);
