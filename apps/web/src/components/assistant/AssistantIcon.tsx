import { AssistantAvatar, useAssistantAvatar, type AvatarExpression } from "./avatar";

/**
 * The user's assistant avatar at a given pixel `size` (default 16). A `size-*`
 * className still wins for layout, so existing call sites keep working.
 */
export function AssistantIcon(props: {
  className?: string | undefined;
  size?: number;
  expression?: AvatarExpression;
}) {
  const [config] = useAssistantAvatar();
  return (
    <AssistantAvatar
      config={config}
      size={props.size ?? 16}
      {...(props.expression ? { expression: props.expression } : {})}
      {...(props.className ? { className: props.className } : {})}
    />
  );
}
