import { PROVIDER_DISPLAY_NAMES, ProviderDriverKind } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isProviderDriverKind = Schema.is(ProviderDriverKind);

const PROVIDER_NAMES = new Map(
  Object.entries(PROVIDER_DISPLAY_NAMES).flatMap(([kind, name]) => (name ? [[kind, name]] : [])),
);

/** Services whose site isn't simply `<name>.com`. */
const DOMAINS: Record<string, string> = {
  sentry: "sentry.io",
  linear: "linear.app",
  notion: "notion.so",
  google_calendar: "calendar.google.com",
  google_drive: "drive.google.com",
  google_sheets: "sheets.google.com",
  google_docs: "docs.google.com",
  gmail: "mail.google.com",
  todoist: "todoist.com",
};

export type ServiceIdentity =
  | { readonly kind: "provider"; readonly provider: ProviderDriverKind; readonly name: string }
  | { readonly kind: "domain"; readonly domain: string; readonly name: string }
  /** Steps calling Signalbox's own tools (`signalbox.<tool>`), shown with its mark. */
  | { readonly kind: "signalbox"; readonly name: "Signalbox" };

/**
 * What a step's logo should show: a provider for agent steps, Signalbox's own
 * mark for its tools, or a web domain whose icon stands for the service
 * (`stripe` → stripe.com, a host stays as is).
 */
export function serviceIdentity(service: string | undefined): ServiceIdentity | null {
  if (!service) return null;
  if (service === "signalbox") return { kind: "signalbox", name: "Signalbox" };
  // Agent steps may name `claude`; the provider is `claudeAgent`.
  const provider = service === "claude" ? "claudeAgent" : service;
  const providerName = PROVIDER_NAMES.get(provider);
  if (providerName && isProviderDriverKind(provider)) {
    return { kind: "provider", provider, name: providerName };
  }
  if (service.includes("."))
    return { kind: "domain", domain: service.replace(/^(www|api)\./, ""), name: service };
  const name = service.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  return {
    kind: "domain",
    domain: DOMAINS[service] ?? `${service.replace(/[_\s]+/g, "")}.com`,
    name,
  };
}
