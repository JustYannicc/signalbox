import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { SymbolView } from "../../components/ui/AppSymbol";
import { useThreadKind } from "../../state/signalboxThreadKinds";

/** Chat or task marker for a thread row. Renders nothing where the environment doesn't serve kinds. */
export function ThreadKindGlyph(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly tintColorClassName: string;
}) {
  const kind = useThreadKind(props.environmentId, props.threadId);
  if (kind === null) return null;
  return (
    <SymbolView
      name={kind === "chat" ? "bubble.left" : "checkmark.circle"}
      size={12}
      tintColorClassName={props.tintColorClassName}
      type="monochrome"
      accessibilityLabel={kind === "chat" ? "Chat" : "Task"}
    />
  );
}
