// signalbox: account pools for agents, so the assistant and its tasks can pick one.
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { AccountPoolOverview } from "@t3tools/contracts/accountHub";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as AccountPools from "../../../accountHub/AccountPools.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as Settings from "../../../serverSettings.ts";
import * as UsageLimitSources from "../../../usage/UsageLimitSources.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const PoolListTool = Tool.make("t3_pool_list", {
  description:
    "List the account pools whose accounts threads run on, with each pool's providers and how much of their usage is left per window and when it next resets. To run a thread or task on a pool, pass one of its providerInstanceId values as the provider instance; orchestrator_capabilities lists that instance's models.",
  success: Schema.Struct({ pools: Schema.Array(AccountPoolOverview) }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    AccountPools.AccountPools,
    Settings.ServerSettingsService,
    ProviderRegistry.ProviderRegistry,
    UsageLimitSources.UsageLimitSources,
  ],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const PoolsToolkit = Toolkit.make(PoolListTool);
