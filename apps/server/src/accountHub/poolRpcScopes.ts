import {
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  WS_METHODS,
} from "@t3tools/contracts";

/**
 * Pool RPCs need the providers scope, which makes a caller a pool admin (see
 * `poolAccess.ts`), except overviews: they carry no account data, so anyone
 * who can read may see them.
 */
export const ACCOUNT_POOL_RPC_SCOPES = {
  [WS_METHODS.usageLimitSourceUpdateAccount]: AuthProvidersManageScope,
  [WS_METHODS.accountPoolSubscribe]: AuthProvidersManageScope,
  [WS_METHODS.accountPoolSubscribeViews]: AuthOrchestrationReadScope,
  [WS_METHODS.accountPoolCreate]: AuthProvidersManageScope,
  [WS_METHODS.accountPoolRename]: AuthProvidersManageScope,
  [WS_METHODS.accountPoolDelete]: AuthProvidersManageScope,
  [WS_METHODS.accountPoolSetBacking]: AuthProvidersManageScope,
  [WS_METHODS.accountPoolImportAccounts]: AuthProvidersManageScope,
  [WS_METHODS.accountPoolAddApiKey]: AuthProvidersManageScope,
  [WS_METHODS.accountPoolMoveNativeLogins]: AuthProvidersManageScope,
  [WS_METHODS.accountPoolSetOpenCode]: AuthProvidersManageScope,
} as const;
