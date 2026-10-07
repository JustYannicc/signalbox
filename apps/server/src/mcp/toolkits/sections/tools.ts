import { OrchestratorMcpFailure } from "@t3tools/contracts";
import {
  SectionCreateInput,
  SectionDeleteInput,
  SectionMoveInput,
  SectionProjectMoveInput,
  SectionProjectChainInput,
  SectionUpdateInput,
  ProjectSectionChain,
  SectionsSnapshot,
} from "@t3tools/contracts/sections";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Sections from "../../../sections/Sections.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  success: SectionsSnapshot,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
    Sections.Sections,
  ],
};

export const SectionsToolkit = Toolkit.make(
  Tool.make("t3_section_list", {
    ...shared,
    description:
      "List this environment's section tree and project placements. Sections only organize the sidebar; they never change storage or access. Projects without a placement are at the root.",
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_project_section_chain", {
    ...shared,
    description:
      "Read a project's section and ancestors, nearest parent first and root last. An unsectioned project returns section:null and no ancestors.",
    parameters: SectionProjectChainInput,
    success: ProjectSectionChain,
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_section_create", {
    ...shared,
    description:
      "Create an organizational section. Use parentId:null for a root section or a section ID to nest it. Requires full access.",
    parameters: SectionCreateInput,
  }).annotate(Tool.Destructive, false),
  Tool.make("t3_section_update", {
    ...shared,
    description:
      "Rename a section, or set the account pool new threads in its projects start on (defaultPoolId; null inherits from the parent section). t3_pool_list lists the pools. A project's own default model still wins. Requires full access.",
    parameters: SectionUpdateInput,
  }).annotate(Tool.Destructive, false),
  Tool.make("t3_section_move", {
    ...shared,
    description:
      "Move or reorder a section. Use parentId:null to move it to the root; omit beforeId to append. Its contents move with it. Requires full access.",
    parameters: SectionMoveInput,
  }).annotate(Tool.Destructive, false),
  Tool.make("t3_section_delete", {
    ...shared,
    description:
      "Delete a section and move its direct child sections and projects up to its parent. No projects, threads or files are deleted. Requires full access.",
    parameters: SectionDeleteInput,
  }).annotate(Tool.Destructive, true),
  Tool.make("t3_project_move_to_section", {
    ...shared,
    description:
      "Move a project into a section, or out to the root with sectionId:null. Omit beforeProjectId to append. Changes sidebar organization only, never the project's files, access or identity. Requires full access.",
    parameters: SectionProjectMoveInput,
  }).annotate(Tool.Destructive, false),
);
