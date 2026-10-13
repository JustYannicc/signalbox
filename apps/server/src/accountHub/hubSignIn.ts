import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import type * as AccountHub from "./AccountHub.ts";
import type { AccountHubError, AccountHubOAuthProvider } from "./accountHubManagement.ts";
import { reauthAccountName, reauthMethods, startReauth } from "./hubReauth.ts";

const PROVIDER_NAMES: Record<AccountHubOAuthProvider, string> = {
  claude: "Claude",
  xai: "Grok",
  antigravity: "Antigravity",
  codex: "ChatGPT",
};

/**
 * Runs one hub login inside a sign-in flow: a device code to enter, or a
 * browser login that can be finished by pasting the provider's final address
 * from another device. Resolves once the hub saved the account.
 */
export const runHubLogin = (options: {
  readonly instanceId: ProviderInstanceId;
  readonly context: ProviderAuthFlow.ProviderAuthFlowContext;
  readonly start: (options: {
    readonly localCallback: boolean;
  }) => Effect.Effect<AccountHub.AccountHubOAuthLogin, AccountHubError>;
}) =>
  Effect.gen(function* () {
    const { context, instanceId } = options;
    const setupError = (operation: string) => (error: AccountHubError) =>
      new ProviderSetupError({ instanceId, operation, detail: error.detail });
    // The hub can only catch a redirect itself when the browser runs on this machine.
    const login = yield* options
      .start({ localCallback: context.callbackMode === "server" })
      .pipe(Effect.mapError(setupError("start")));
    yield* Effect.addFinalizer(() => login.cancel);
    if (login.userCode) {
      yield* context.setInteraction({
        type: "deviceCode",
        id: context.flowId,
        url: login.url,
        userCode: login.userCode,
      });
    } else {
      yield* context.setInteraction(
        {
          type: "browser",
          id: context.flowId,
          url: login.url,
          requiresConsent: false,
          acceptsCallback: true,
        },
        undefined,
        (callbackUrl) => login.complete(callbackUrl).pipe(Effect.mapError(setupError("complete"))),
      );
    }
    yield* login.await.pipe(Effect.mapError(setupError("save")));
  });

/** A "Sign in to … again" method, run as a hub login for that account. */
export const runHubReauth = (options: {
  readonly hub: AccountHub.AccountHub["Service"];
  readonly instanceId: ProviderInstanceId;
  readonly accountName: string;
  readonly context: ProviderAuthFlow.ProviderAuthFlowContext;
}) =>
  runHubLogin({
    instanceId: options.instanceId,
    context: options.context,
    start: (login) => startReauth(options.hub, options.accountName, login),
  });

/**
 * Sign-in for a hub instance whose logins the hub runs itself. Every sign-in
 * adds one account to the pool; accounts whose login died get their own
 * "Sign in to … again" method.
 */
export const makeHubSignIn = (options: {
  readonly hub: AccountHub.AccountHub["Service"];
  readonly instanceId: ProviderInstanceId;
  readonly provider: AccountHubOAuthProvider;
}) => {
  const name = PROVIDER_NAMES[options.provider];
  return ProviderAuthFlow.make({
    instanceId: options.instanceId,
    credentialBinding: { owner: "t3", key: `account-hub:${options.instanceId}` },
    refreshMethodsAfterAuth: true,
    defaultMethodId: `${options.provider}-add-account`,
    methods: reauthMethods(options.hub, [options.provider]).pipe(
      Effect.map((reauth) => [
        {
          id: `${options.provider}-add-account`,
          name: `Add a ${name} account`,
          description: `Sign in with ${name}. The account joins this pool.`,
          type: "agent" as const,
        },
        ...reauth,
      ]),
    ),
    authenticate: (methodId, context) => {
      const accountName = reauthAccountName(methodId);
      return accountName
        ? runHubReauth({ hub: options.hub, instanceId: options.instanceId, accountName, context })
        : runHubLogin({
            instanceId: options.instanceId,
            context,
            start: (login) => options.hub.startOAuthLogin(options.provider, login),
          });
    },
    logout: Effect.succeed("Accounts stay in the pool. Remove or pause them from Usage → Limits."),
  });
};
