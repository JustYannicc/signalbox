import type { AutomationConnectedService } from "@t3tools/contracts";

import { serviceIdentity } from "./services.ts";

/** One service in Settings → Connected services, with every account the user connected for it. */
export interface ConnectedServiceGroup {
  /** What `w.call` operations start with, e.g. `gmail` in `gmail.users.messages.list`. */
  readonly integration: string;
  readonly label: string;
  /** Whose favicon stands for the service. */
  readonly domain: string;
  /** Account names to pass as `{ connection }` when there's more than one. */
  readonly accounts: ReadonlyArray<string>;
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

/** Groups Executor's connections by integration, in the order the server sorted them. */
export function groupConnectedServices(
  services: ReadonlyArray<AutomationConnectedService>,
): ReadonlyArray<ConnectedServiceGroup> {
  const groups = new Map<string, { readonly integration: string; accounts: string[] }>();
  for (const service of services) {
    const group = groups.get(service.integration);
    if (group) group.accounts.push(service.name);
    else
      groups.set(service.integration, {
        integration: service.integration,
        accounts: [service.name],
      });
  }
  return [...groups.values()].map((group) => ({
    ...group,
    ...describeIntegration(group.integration),
  }));
}
