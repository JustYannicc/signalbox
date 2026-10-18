import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { SIGNALBOX_ASK_TOOLS } from "@t3tools/contracts/signalboxAskTools";
import * as Crypto from "effect/Crypto";
import { Tool } from "effect/ai";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagement.ThreadManagementService,
  Crypto.Crypto,
];
export const askTools = [
  Tool.make("t3_ask_raise", {
    ...SIGNALBOX_ASK_TOOLS.t3_ask_raise,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies,
  }).annotate(Tool.Destructive, true),
  Tool.make("t3_ask_list", {
    ...SIGNALBOX_ASK_TOOLS.t3_ask_list,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_ask_read", {
    ...SIGNALBOX_ASK_TOOLS.t3_ask_read,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_ask_answer", {
    ...SIGNALBOX_ASK_TOOLS.t3_ask_answer,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies,
  }).annotate(Tool.Destructive, true),
  Tool.make("t3_ask_withdraw", {
    ...SIGNALBOX_ASK_TOOLS.t3_ask_withdraw,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies,
  }).annotate(Tool.Destructive, true),
] as const;
