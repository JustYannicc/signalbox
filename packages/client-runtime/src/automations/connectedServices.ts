import type { AutomationConnectedService } from "@t3tools/contracts";

import { serviceIdentity } from "./services.ts";

/** One app a connected account reaches, such as Gmail on a Google account. */
export interface ConnectedApp {
  /** What `w.call` operations start with, e.g. `gmail` in `gmail.users.messages.list`. */
  readonly integration: string;
  readonly label: string;
  /** Whose favicon stands for the app. */
  readonly domain: string;
  /** The connection name to pass as `{ connection }` when there's more than one. */
  readonly connection: string;
}

/** One row in Settings → Connected services: an account and the apps it's connected to. */
export interface ConnectedAccountGroup {
  readonly key: string;
  /** The verified identity's label, such as an email, or the connection name when unverified. */
  readonly label: string;
  readonly verified: boolean;
  readonly apps: ReadonlyArray<ConnectedApp>;
}

const TLD = /^(.+)_(com|io|app|ai|dev|so|co|org|net|sh)$/;

/** Executor names integrations like `todoist_com`, `sentry_io` or `spotify_web_api`. */
function describeIntegration(integration: string) {
  const base = integration.replace(/_(web_)?api$/, "");
  const tld = TLD.exec(base);
  const key = tld?.[1] ?? base;
  const identity = serviceIdentity(key);
  const label = identity?.name ?? key;
  if (tld) return { label, domain: `${key.replace(/_/g, "-")}.${tld[2]}` };
  return { label, domain: identity?.kind === "domain" ? identity.domain : `${key}.com` };
}

/**
 * Groups connections by the verified identity they signed in as, the way the
 * tools service's Accounts page does, so one Google account lists Gmail, Drive
 * and Photos under it. An unverified connection is its own account: a matching
 * label or email is never proof two connections are the same person. Keeps the
 * order the server sorted them in.
 */
export function groupConnectedServices(
  services: ReadonlyArray<AutomationConnectedService>,
): ReadonlyArray<ConnectedAccountGroup> {
  const groups = new Map<
    string,
    {
      readonly key: string;
      readonly label: string;
      readonly verified: boolean;
      apps: ConnectedApp[];
    }
  >();
  for (const service of services) {
    const app = {
      ...describeIntegration(service.integration),
      integration: service.integration,
      connection: service.name,
    };
    // The prefixes keep a verified id from colliding with a connection's own key.
    const key = service.account
      ? `account:${service.account.id}`
      : `connection:${service.integration}/${service.name}`;
    const group = groups.get(key);
    if (group) group.apps.push(app);
    else
      groups.set(key, {
        key,
        label: service.account?.label ?? service.name,
        verified: service.account !== undefined,
        apps: [app],
      });
  }
  return [...groups.values()];
}
