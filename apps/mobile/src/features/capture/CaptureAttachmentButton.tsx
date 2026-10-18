import type { MenuAction } from "@react-native-menu/menu";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";
import { useLayoutEffect, useRef, useState } from "react";
import { Pressable } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import {
  convertPastedImagesToAttachments,
  persistComposerAttachmentFile,
  pickComposerFiles,
  pickComposerMedia,
  type DraftComposerAttachment,
} from "../../lib/composerImages";
import { beginForegroundHandoff } from "../../lib/foreground-handoff";
import type { CaptureAddAttachments } from "./useCaptureDraft";

const PHOTO_ACTION = { id: "photos", title: "Photo Library", image: "photo" };
const CAMERA_ACTION = { id: "camera", title: "Take Photo", image: "camera" };
const FILE_ACTION = { id: "files", title: "Choose Files", image: "folder" };

type AttachmentPickResult = {
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly error: string | null;
};

export function CaptureAttachmentButton(props: {
  readonly disabled: boolean;
  readonly existingCount: number;
  readonly supportsFiles: boolean;
  readonly maxFileBytes?: number;
  readonly maxVideoBytes?: number;
  readonly onAddAttachments: CaptureAddAttachments;
  readonly onError: (message: string) => void;
}) {
  const [isPicking, setIsPicking] = useState(false);
  const onAddAttachmentsRef = useRef(props.onAddAttachments);
  const onErrorRef = useRef(props.onError);
  useLayoutEffect(() => {
    onAddAttachmentsRef.current = props.onAddAttachments;
    onErrorRef.current = props.onError;
  }, [props.onAddAttachments, props.onError]);
  const actions: MenuAction[] = [
    PHOTO_ACTION,
    CAMERA_ACTION,
    ...(props.supportsFiles ? [FILE_ACTION] : []),
  ];
  const disabled =
    props.disabled || isPicking || props.existingCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS;

  const runPicker = async (picker: () => Promise<AttachmentPickResult>) => {
    if (disabled) return;
    setIsPicking(true);
    try {
      const result = await picker();
      let rejected = 0;
      if (result.attachments.length > 0) {
        rejected = onAddAttachmentsRef.current(result.attachments);
      }
      const errors = [
        result.error,
        rejected > 0 ? `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} items.` : null,
      ].filter(
        (message, index, all): message is string =>
          message !== null && all.indexOf(message) === index,
      );
      if (errors.length > 0) onErrorRef.current(errors.join(" "));
    } catch (error) {
      onErrorRef.current(error instanceof Error ? error.message : "Could not add that attachment.");
    } finally {
      setIsPicking(false);
    }
  };

  const pickPhotos = async () => {
    const result = await pickComposerMedia({
      existingCount: props.existingCount,
      ...(props.maxVideoBytes !== undefined ? { maxVideoBytes: props.maxVideoBytes } : {}),
    });
    return { attachments: result.attachments, error: result.error };
  };

  const pickFiles = async () => {
    const result = await pickComposerFiles({
      existingCount: props.existingCount,
      maxBytes: props.maxFileBytes,
    });
    return { attachments: result.files, error: result.error };
  };

  const takePhoto = async () => {
    const imagePicker = await import("expo-image-picker");
    const permission = await imagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      throw new Error("Camera access is needed to take a photo.");
    }

    const endHandoff = beginForegroundHandoff();
    let result: Awaited<ReturnType<typeof imagePicker.launchCameraAsync>>;
    try {
      result = await imagePicker.launchCameraAsync({
        mediaTypes: ["images"],
        allowsEditing: false,
        base64: false,
        quality: 1,
      });
    } finally {
      endHandoff();
    }
    if (result.canceled) return { attachments: [], error: null };

    const converted = await convertPastedImagesToAttachments({
      uris: result.assets.map((asset) => asset.uri),
      existingCount: props.existingCount,
    });
    const { File } = await import("expo-file-system");
    const attachments: DraftComposerAttachment[] = [];
    for (const image of converted) {
      const fileUri = await persistComposerAttachmentFile(
        image.previewUri,
        image.name,
        PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
      );
      const { dataUrl: _discardInlineBytes, ...metadata } = image;
      const file = new File(fileUri);
      attachments.push({
        ...metadata,
        fileUri,
        previewUri: fileUri,
        sizeBytes: file.size ?? image.sizeBytes,
      });
    }
    if (result.assets.length > 0 && attachments.length === 0) {
      throw new Error("That photo could not be attached. Try another one.");
    }
    return { attachments, error: null };
  };

  return (
    <Menu
      accessible
      accessibilityLabel="Add attachment"
      accessibilityRole="button"
      actions={actions}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "photos") void runPicker(pickPhotos);
        else if (nativeEvent.event === "camera") void runPicker(takePhoto);
        else if (nativeEvent.event === "files") void runPicker(pickFiles);
      }}
    >
      <Pressable
        accessibilityLabel="Add attachment"
        accessibilityRole="button"
        accessibilityState={{ disabled, busy: isPicking }}
        className="size-12 shrink-0 items-center justify-center rounded-full active:opacity-70 disabled:opacity-50"
        disabled={disabled}
      >
        {isPicking ? (
          <AppActivityIndicator />
        ) : (
          <SymbolView
            name="plus"
            size={20}
            weight="regular"
            tintColorClassName="accent-icon"
            type="monochrome"
          />
        )}
      </Pressable>
    </Menu>
  );
}
