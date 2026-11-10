import type { EnvironmentId } from "@t3tools/contracts";
import type { AskKitImage, AskKitPreview } from "@t3tools/contracts/askKit";
import type { SignalboxAskQuestion } from "@t3tools/contracts/signalboxAsks";
import type { AskKitComponentSpec } from "@t3tools/shared/askKit";
import { Image } from "expo-image";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { assetImageSource } from "../../lib/assetImageSource";
import { cn } from "../../lib/cn";
import { useAssetUrlState } from "../../state/assets";
import { RequestActionButton } from "../threads/RequestActionButton";
import { AskHtmlWebView } from "./AskHtmlWebView";
import { nativeFontStyle, OptionSwatch } from "./AskChoices";

type CompareSpec = Extract<AskKitComponentSpec, { component: "compare" }>;

const PANE_HEIGHT = 180;

function PanePlaceholder(props: { readonly text: string }) {
  return (
    <View
      style={{ height: PANE_HEIGHT }}
      className="items-center justify-center rounded-[12px] bg-subtle-strong"
    >
      <Text className="font-sans text-sm text-foreground-muted">{props.text}</Text>
    </View>
  );
}

function AskImageView(props: {
  readonly image: AskKitImage;
  readonly alt: string;
  readonly environmentId: EnvironmentId;
}) {
  const { image } = props;
  const resource =
    image.source === "attachment"
      ? {
          _tag: "attachment" as const,
          attachmentId: image.attachmentId,
          mimeType: image.mimeType,
          disposition: "inline" as const,
        }
      : null;
  const asset = useAssetUrlState(resource === null ? null : props.environmentId, resource);
  const source =
    image.source === "https"
      ? { uri: image.url }
      : image.source === "data"
        ? { uri: image.dataUrl }
        : resource !== null && asset._tag === "Success"
          ? assetImageSource(props.environmentId, resource, asset.url)
          : null;
  if (source === null) {
    return (
      <PanePlaceholder text={asset._tag === "Failure" ? "Image unavailable" : "Loading image…"} />
    );
  }
  return (
    <Image
      source={source}
      accessibilityLabel={props.alt}
      cachePolicy="memory-disk"
      contentFit="contain"
      style={{ width: "100%", height: PANE_HEIGHT, borderRadius: 12 }}
    />
  );
}

function PanePreview(props: {
  readonly preview: AskKitPreview;
  readonly environmentId: EnvironmentId;
}) {
  const { preview } = props;
  switch (preview.kind) {
    case "image":
      return (
        <AskImageView image={preview.image} alt={preview.alt} environmentId={props.environmentId} />
      );
    case "html":
      return <AskHtmlWebView html={preview.html} title={preview.title} maxHeight={320} />;
    case "thread-preview":
      // Live browser tabs open in the desktop and web panels; the phone shows their still.
      return preview.still ? (
        <AskImageView
          image={preview.still.image}
          alt={preview.still.alt}
          environmentId={props.environmentId}
        />
      ) : (
        <PanePlaceholder text="Live preview on desktop or web" />
      );
  }
}

/** Panes one above another; picking one answers with its option. Nothing is picked until chosen. */
export function AskCompare(props: {
  readonly options: SignalboxAskQuestion["options"];
  readonly spec: CompareSpec;
  readonly selected: number | undefined;
  readonly disabled: boolean;
  readonly environmentId: EnvironmentId;
  readonly onChange: (selected: number | undefined) => void;
}) {
  return (
    <View className="gap-3">
      {props.spec.panes.map((pane) => {
        const option = props.options[pane.option];
        const picked = props.selected === pane.option;
        const look = props.spec.looks[pane.option];
        return (
          <View
            key={pane.option}
            className={cn(
              "gap-2 rounded-[16px] border bg-card p-2",
              picked ? "border-primary" : "border-border",
            )}
          >
            <PanePreview preview={pane.preview} environmentId={props.environmentId} />
            <View className="flex-row items-center gap-2 px-1">
              <OptionSwatch color={look?.color} />
              <View className="flex-1">
                <Text
                  className="font-t3-bold text-sm text-foreground"
                  style={nativeFontStyle(look?.font)}
                >
                  {option?.label ?? ""}
                </Text>
                {pane.caption ? (
                  <Text className="font-sans text-xs text-foreground-muted">{pane.caption}</Text>
                ) : null}
              </View>
              <RequestActionButton
                label={picked ? "Picked" : "Pick"}
                tone={picked ? "primary" : "secondary"}
                accessibilityLabel={`Pick ${option?.label ?? "this option"}`}
                accessibilityState={{ selected: picked }}
                disabled={props.disabled}
                onPress={() => props.onChange(picked ? undefined : pane.option)}
              />
            </View>
          </View>
        );
      })}
    </View>
  );
}
