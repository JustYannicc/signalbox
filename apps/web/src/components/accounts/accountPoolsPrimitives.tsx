import { ProviderDriverKind } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { PROVIDER_PRESENTATION } from "../usage/usageProviders";
import type { PoolHarness } from "./accountPoolsModel";

/** The same series colour the usage charts use, so both pages read as one. */
export function poolColor(harness: PoolHarness): string {
  return PROVIDER_PRESENTATION[harness].color;
}

/** The provider driver the real Limits components key their colours on. */
export const POOL_DRIVER: Record<PoolHarness, ProviderDriverKind> = {
  codex: ProviderDriverKind.make("codex"),
  claude: ProviderDriverKind.make("claudeAgent"),
  grok: ProviderDriverKind.make("grok"),
};

export function PoolMark({
  harness,
  className,
}: {
  readonly harness: PoolHarness;
  readonly className?: string;
}) {
  const Mark = PROVIDER_PRESENTATION[harness].mark;
  return <Mark className={cn("shrink-0", className)} aria-hidden />;
}
