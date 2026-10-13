import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  WS_METHODS,
} from "@t3tools/contracts";

export const SECTIONS_RPC_REQUIRED_SCOPES = {
  [WS_METHODS.sectionsSubscribe]: AuthOrchestrationReadScope,
  [WS_METHODS.sectionsCreate]: AuthOrchestrationOperateScope,
  [WS_METHODS.sectionsUpdate]: AuthOrchestrationOperateScope,
  [WS_METHODS.sectionsMove]: AuthOrchestrationOperateScope,
  [WS_METHODS.sectionsDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.sectionsMoveProject]: AuthOrchestrationOperateScope,
} as const;
