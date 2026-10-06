import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ProviderAuthFlow from "../provider/ProviderAuthFlow.ts";
import type * as AccountHub from "./AccountHub.ts";
import type { AccountHubOAuthProvider } from "./accountHubManagement.ts";

const PROVIDER_NAMES: Record<AccountHubOAuthProvider, string> = {
  claude: "Claude",
  xai: "Grok",
  antigravity: "Antigravity",
};

/**
 * Sign-in for a hub instance whose logins the hub runs itself. Every sign-in
 * adds one account to the pool. Browser logins can be finished by pasting the
 * provider's final address from another device; device logins show a code.
 */
export const makeHubSignIn = (options: {
  readonly hub: AccountHub.AccountHub["Service"];
  readonly instanceId: ProviderInstanceId;
  readonly provider: AccountHubOAuthProvider;
}) => {
  const name = PROVIDER_NAMES[options.provider];
  const setupError = (operation: string, detail: string) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail });
  return ProviderAuthFlow.make({
    instanceId: options.instanceId,
    credentialBinding: { owner: "t3", key: `account-hub:${options.instanceId}` },
    methods: Effect.succeed([
      {
        id: `${options.provider}-add-account`,
        name: `Add a ${name} account`,
        description: `Sign in with ${name}. The account joins this pool.`,
        type: "agent" as const,
      },
    ]),
    authenticate: (_method, context) =>
      Effect.gen(function* () {
        // The hub can only catch a redirect itself when the browser runs on this machine.
        const login = yield* options.hub
          .startOAuthLogin(options.provider, { localCallback: context.callbackMode === "server" })
          .pipe(Effect.mapError((error) => setupError("start", error.detail)));
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
            (callbackUrl) =>
              login
                .complete(callbackUrl)
                .pipe(Effect.mapError((error) => setupError("complete", error.detail))),
          );
        }
        yield* login.await.pipe(Effect.mapError((error) => setupError("save", error.detail)));
      }),
    logout: Effect.succeed("Accounts stay in the pool. Remove or pause them from Usage → Limits."),
  });
};
