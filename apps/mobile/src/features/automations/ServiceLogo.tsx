import { serviceIdentity } from "@t3tools/client-runtime/automations/services";
import type { WorkflowStepVerb } from "@t3tools/contracts";
import { Image } from "expo-image";
import { memo, useState } from "react";
import { View } from "react-native";

import { SymbolView, type AppSymbolViewProps } from "../../components/AppSymbol";
import { ProviderIcon } from "../../components/ProviderIcon";

const VERB_SYMBOL: Record<WorkflowStepVerb, AppSymbolViewProps["name"]> = {
  agent: { ios: "sparkles", android: "auto_awesome" },
  call: "link",
  http: "globe",
  run: "terminal",
  llm: "text.alignleft",
  judge: "arrow.triangle.branch",
  extract: "doc.text",
  ask: { ios: "questionmark.bubble", android: "chat" },
  notify: "bell.badge",
  sleep: "timer",
  waitFor: "clock",
  recall: "internaldrive",
  remember: "internaldrive",
  start: "play",
};

/**
 * What a step talks to: the provider's mark for agent steps, the service's
 * favicon for calls and web requests, and the step's verb when neither is known
 * or the favicon can't load.
 */
export const ServiceLogo = memo(function ServiceLogo(props: {
  readonly verb: WorkflowStepVerb;
  readonly service: string | undefined;
  readonly size?: number;
}) {
  const size = props.size ?? 28;
  const glyph = Math.round(size * 0.58);
  const identity = serviceIdentity(props.service);
  const [failedDomain, setFailedDomain] = useState<string | null>(null);
  const domain = identity?.kind === "domain" ? identity.domain : null;
  const showFavicon = domain !== null && failedDomain !== domain;

  return (
    <View
      accessibilityLabel={identity?.name}
      className="items-center justify-center rounded-[9px] border border-border-subtle bg-card"
      style={{ width: size, height: size }}
    >
      {identity?.kind === "provider" ? (
        <ProviderIcon provider={identity.provider} size={glyph} />
      ) : showFavicon ? (
        <Image
          accessibilityIgnoresInvertColors
          cachePolicy="memory-disk"
          contentFit="contain"
          recyclingKey={domain}
          source={{ uri: `https://icons.duckduckgo.com/ip3/${domain}.ico` }}
          style={{ width: glyph, height: glyph, borderRadius: 3 }}
          onError={() => setFailedDomain(domain)}
        />
      ) : (
        <SymbolView
          name={VERB_SYMBOL[props.verb]}
          size={glyph}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
      )}
    </View>
  );
});
