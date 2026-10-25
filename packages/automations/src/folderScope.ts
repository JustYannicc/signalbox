import type { AutomationError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/** Folder scopes visible to an automation name lookup, nearest first. */
export class AutomationFolders extends Context.Service<
  AutomationFolders,
  {
    readonly projects: (projectId: string) => Effect.Effect<ReadonlyArray<string>, AutomationError>;
  }
>()("@signalbox/automations/folderScope/AutomationFolders") {}
