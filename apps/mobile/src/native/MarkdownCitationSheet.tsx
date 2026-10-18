import type { AssistantCitation } from "@t3tools/contracts";
import { ScrollView, View } from "react-native";

import { AppText } from "../components/ui/AppText";
import { Sheet } from "../components/ui/Sheet";
import { CopyTextButton } from "../features/threads/CopyTextButton";
import { useResolveClassNames } from "uniwind";

export function MarkdownCitationSheet(props: {
  readonly citation: AssistantCitation;
  readonly onClose: () => void;
}) {
  const copyStyle = useResolveClassNames("text-foreground-muted");
  return (
    <Sheet title="Assistant quote" onClose={props.onClose}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: 20, gap: 16 }}
      >
        <View className="flex-row items-start gap-2">
          <AppText selectable className="min-w-0 flex-1 text-base text-foreground">
            {props.citation.text}
          </AppText>
          <CopyTextButton
            accessibilityLabel="Copy quote"
            text={props.citation.text}
            tintColor={copyStyle.color}
            buttonSize={32}
            iconSize={16}
          />
        </View>
        {props.citation.comment !== undefined ? (
          <View className="gap-2">
            <AppText className="text-xs text-foreground-muted">Comment</AppText>
            <AppText selectable className="text-base text-foreground">
              {props.citation.comment}
            </AppText>
          </View>
        ) : null}
      </ScrollView>
    </Sheet>
  );
}
