import {
  codexArtifactTemplatePresentationLabel,
  type CodexArtifactTemplate,
} from "@t3tools/shared/codexArtifactTemplates";
import type { ThreadFindDocument } from "@t3tools/shared/threadFindText";
import type { TextRange } from "@t3tools/shared/textSourceMap";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { useResolveClassNames } from "uniwind";
import type { NativeMarkdownTextStyle } from "../../native/SelectableMarkdownText";
import { ThreadFindGeneratedText } from "./find/ThreadFindGeneratedText";

const SYMBOL_BY_KIND: Record<CodexArtifactTemplate["artifactKind"], AppSymbolName> = {
  document: "doc.text",
  presentation: "chart.bar.xaxis",
  spreadsheet: "chart.bar.xaxis",
  site: "safari",
  "google-docs": "doc.text",
  "google-slides": "chart.bar.xaxis",
  "google-sheets": "chart.bar.xaxis",
  image: "camera",
  email: "text.bubble",
  slack: "text.bubble",
};

export function ThreadArtifactTemplateCard(props: {
  readonly template: CodexArtifactTemplate;
  readonly onUse?: ((template: CodexArtifactTemplate) => void) | undefined;
  readonly find?:
    | {
        readonly entryId: string;
        readonly document: ThreadFindDocument;
        readonly sourceRange: TextRange;
        readonly textStyle: NativeMarkdownTextStyle;
      }
    | undefined;
}) {
  const nameStyle = useResolveClassNames("text-foreground");
  const kindStyle = useResolveClassNames("text-foreground-muted");
  const kindLabel = codexArtifactTemplatePresentationLabel(props.template.artifactKind);
  const find = props.find;
  const label = (kind: "artifact-name" | "artifact-kind", text: string) =>
    find ? (
      <ThreadFindGeneratedText
        entryId={find.entryId}
        document={find.document}
        numberOfLines={kind === "artifact-name" ? 1 : undefined}
        slot={{ kind, sourceStart: find.sourceRange.start, sourceEnd: find.sourceRange.end, text }}
        textStyle={{
          ...find.textStyle,
          fontSize: kind === "artifact-name" ? 14 : 12,
          lineHeight: kind === "artifact-name" ? 20 : 16,
          fontFamily:
            kind === "artifact-name" ? find.textStyle.boldFontFamily : find.textStyle.fontFamily,
          color:
            kind === "artifact-name" && typeof nameStyle.color === "string"
              ? nameStyle.color
              : typeof kindStyle.color === "string"
                ? kindStyle.color
                : find.textStyle.color,
        }}
      />
    ) : (
      <Text
        className={
          kind === "artifact-name"
            ? "font-t3-bold text-sm text-foreground"
            : "text-xs text-foreground-muted"
        }
        numberOfLines={kind === "artifact-name" ? 1 : undefined}
      >
        {text}
      </Text>
    );
  return (
    <View className="my-2 min-w-0 flex-row items-center gap-3 rounded-2xl border border-border bg-card px-3 py-3">
      <View className="relative h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-subtle">
        <SymbolView
          name={SYMBOL_BY_KIND[props.template.artifactKind]}
          size={20}
          tintColorClassName="accent-foreground-muted"
          type="monochrome"
        />
        <View className="absolute -right-1 -bottom-1 h-4 w-4 items-center justify-center rounded-full bg-fuchsia-500">
          <SymbolView
            name={{ ios: "sparkles", android: "auto_awesome" }}
            size={9}
            tintColor="white"
            type="monochrome"
          />
        </View>
      </View>
      <View className="min-w-0 flex-1">
        {label("artifact-name", props.template.displayName)}
        {label("artifact-kind", kindLabel)}
      </View>
      {props.onUse ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Use ${props.template.displayName} template`}
          className="min-h-9 justify-center rounded-lg border border-border bg-subtle px-3 active:opacity-65"
          onPress={() => props.onUse?.(props.template)}
        >
          <Text className="font-t3-bold text-xs text-foreground">Use template</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
