import {
  captureTitle,
  findFolderTrigger,
  rankByLabel,
  removeTriggerText,
} from "@t3tools/client-runtime/capture/text";
import {
  StackActions,
  useNavigation,
  usePreventRemove,
  type NavigationAction,
} from "@react-navigation/native";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { KeyboardAvoidingView, KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  ComposerEditor,
  type ComposerEditorHandle,
  type ComposerEditorSelection,
} from "../../components/ComposerEditor";
import { ComposerAttachmentStrip } from "../../components/ComposerAttachmentStrip";
import { AndroidScreenHeader } from "../../components/ui/AndroidScreenHeader";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Toast } from "../../components/ui/Toast";
import { Toolbar } from "../../components/ui/Toolbar";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import {
  composerStripAttachments,
  convertPastedImagesToAttachments,
} from "../../lib/composerImages";
import { useProjects, useEnvironmentServerConfig } from "../../state/entities";
import { folderEnvironmentsAtom } from "../../state/signalboxFolders";
import {
  flushComposerDrafts,
  getComposerDraftSnapshot,
  rememberComposerDraftSelection,
} from "../../state/use-composer-drafts";
import { CaptureAttachmentButton } from "./CaptureAttachmentButton";
import { resolveCaptureTargetSelection, resolveCaptureTargets } from "./destinations";
import { useCaptureDraft } from "./useCaptureDraft";

export function CaptureRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const folderEnvironments = useAtomValue(folderEnvironmentsAtom);
  const projects = useProjects();
  const inputRef = useRef<ComposerEditorHandle>(null);
  const selectionRef = useRef<ComposerEditorSelection>({ start: 0, end: 0 });
  const pendingRemovalActionRef = useRef<NavigationAction | null>(null);
  const pendingRemovalToDispatchRef = useRef<NavigationAction | null>(null);
  const persistenceRef = useRef<Promise<boolean> | null>(null);
  const [selectedDestinationKey, setSelectedDestinationKey] = useState<string | null>(null);
  const [caret, setCaret] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [allowRemoval, setAllowRemoval] = useState(false);
  const [saved, setSaved] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const { targets, personal } = useMemo(
    () => resolveCaptureTargets(folderEnvironments, projects),
    [folderEnvironments, projects],
  );
  const labeledTargets = useMemo(
    () => targets.map((target) => ({ ...target, label: target.destination.label })),
    [targets],
  );
  const [initialPersonalDestinationKey, setInitialPersonalDestinationKey] = useState(
    () => personal?.destination.key ?? null,
  );
  if (initialPersonalDestinationKey === null && personal) {
    setInitialPersonalDestinationKey(personal.destination.key);
  }
  const selectedTarget = resolveCaptureTargetSelection(
    targets,
    initialPersonalDestinationKey,
    selectedDestinationKey,
  );
  const destinationUnavailable =
    selectedTarget === null &&
    (initialPersonalDestinationKey !== null || selectedDestinationKey !== null);
  const captureDraft = useCaptureDraft(selectedTarget);
  const {
    addAttachments,
    awaitImports,
    draft,
    draftKey,
    isImporting,
    prepare,
    retarget,
    setText,
    trackImport,
  } = captureDraft;
  useEffect(() => {
    if (!selectedTarget || draftKey !== null) return;
    // The editor consumes native context paste only when it has a durable draft key.
    prepare();
  }, [draftKey, prepare, selectedTarget]);
  const selectedConfig = useEnvironmentServerConfig(selectedTarget?.start.environmentId ?? null);
  const hasContent = draft.text.length > 0 || draft.attachments.length > 0;
  const hasCapture = hasContent || isImporting;
  const draftEnvironmentId = selectedTarget?.start.environmentId ?? draft.project?.environmentId;
  const saveDisabled = !hasCapture || selectedTarget === null || isSaving;
  const activeTrigger = useMemo(() => findFolderTrigger(draft.text, caret), [caret, draft.text]);
  const suggestions = activeTrigger
    ? rankByLabel(labeledTargets, activeTrigger.query, 5)
    : destinationUnavailable && draftKey === null
      ? rankByLabel(labeledTargets, "", labeledTargets.length)
      : [];
  const selectedLabel = selectedTarget?.destination.label ?? "Choose a destination";

  const persistDraft = useCallback((): Promise<boolean> => {
    if (persistenceRef.current) return persistenceRef.current;
    if (!hasCapture) return Promise.resolve(false);
    const operation = (async () => {
      setIsSaving(true);
      setErrorMessage(null);
      try {
        await awaitImports();
        const key = prepare() ?? draftKey;
        if (!key) return false;
        const current = getComposerDraftSnapshot(key);
        if (current.text.length === 0 && current.attachments.length === 0) return true;
        await flushComposerDrafts();
        setSaved(true);
        return true;
      } catch {
        setErrorMessage(
          "Couldn't save this capture. Your text and attachments are still here. Try again.",
        );
        return false;
      } finally {
        setIsSaving(false);
        persistenceRef.current = null;
      }
    })();
    persistenceRef.current = operation;
    return operation;
  }, [awaitImports, draftKey, hasCapture, prepare]);

  const requestDismiss = useCallback(() => navigation.goBack(), [navigation]);

  usePreventRemove(hasCapture && !allowRemoval, ({ data }) => {
    if (pendingRemovalActionRef.current) return;
    pendingRemovalActionRef.current = data.action;
    void persistDraft().then((didPersist) => {
      if (!didPersist) {
        pendingRemovalActionRef.current = null;
        return;
      }
      pendingRemovalToDispatchRef.current = data.action;
      pendingRemovalActionRef.current = null;
      setAllowRemoval(true);
    });
  });

  useEffect(() => {
    if (!allowRemoval) return;
    const action = pendingRemovalToDispatchRef.current;
    if (!action) return;
    const frame = requestAnimationFrame(() => {
      pendingRemovalToDispatchRef.current = null;
      navigation.dispatch(action);
    });
    return () => cancelAnimationFrame(frame);
  }, [allowRemoval, navigation]);

  const save = useCallback(() => {
    setErrorMessage(null);
    void persistDraft();
  }, [persistDraft]);

  const openDraft = useCallback(async () => {
    const didPersist = await persistDraft();
    if (!didPersist || !draftKey || !selectedTarget) return;
    navigation.dispatch(
      StackActions.replace("NewTaskSheet", {
        screen: "NewTaskDraft",
        params: {
          environmentId: selectedTarget.start.environmentId,
          projectId: selectedTarget.start.projectId,
          draftId: draftKey,
          title: captureTitle(draft.text) || "New task",
        },
      }),
    );
  }, [draft.text, draftKey, navigation, persistDraft, selectedTarget]);

  const selectDestination = useCallback(
    (target: (typeof targets)[number]) => {
      setSelectedDestinationKey(target.destination.key);
      setSaved(false);
      setErrorMessage(null);
      if (draftKey) {
        const { text, caret: nextCaret } = activeTrigger
          ? removeTriggerText(draft.text, activeTrigger)
          : { text: draft.text, caret };
        setText(text);
        selectionRef.current = { start: nextCaret, end: nextCaret };
        setCaret(nextCaret);
        if (draftKey) {
          rememberComposerDraftSelection(draftKey, text, selectionRef.current);
        }
        retarget(target);
        requestAnimationFrame(() => {
          inputRef.current?.setSelection(selectionRef.current);
        });
      }
    },
    [activeTrigger, caret, draft.text, draftKey, retarget, setText],
  );

  const handleTextChange = useCallback(
    (text: string) => {
      setSaved(false);
      setErrorMessage(null);
      setText(text);
      setCaret(Math.min(selectionRef.current.start, text.length));
    },
    [setText],
  );

  const handleSelectionChange = useCallback(
    (selection: ComposerEditorSelection) => {
      selectionRef.current = selection;
      setCaret(selection.start);
      if (draftKey) rememberComposerDraftSelection(draftKey, draft.text, selection);
    },
    [draft.text, draftKey],
  );

  const handlePasteImages = useCallback(
    async (uris: ReadonlyArray<string>) => {
      if (!selectedTarget) {
        setErrorMessage("Choose a destination before adding attachments.");
        return;
      }
      if (draft.attachments.length >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        setErrorMessage(`You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} items.`);
        return;
      }
      const insertion = { text: draft.text, ...selectionRef.current };
      try {
        await trackImport(async () => {
          const attachments = await convertPastedImagesToAttachments({
            uris,
            existingCount: draft.attachments.length,
          });
          if (attachments.length === 0) return;
          const rejected = addAttachments(attachments, insertion);
          setSaved(false);
          if (rejected > 0) {
            setErrorMessage(`You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} items.`);
          } else {
            setErrorMessage(null);
          }
        });
      } catch (error) {
        setErrorMessage(
          error instanceof Error ? error.message : "Couldn't add that image. Try again.",
        );
      }
    },
    [addAttachments, draft.attachments.length, draft.text, selectedTarget, trackImport],
  );

  const openSavedDraft = useCallback(() => {
    void openDraft();
  }, [openDraft]);

  const noPersonalDestination = personal === null && !destinationUnavailable;
  const showPersonalLoading = noPersonalDestination && (projects.length === 0 || folderEnvironments.size === 0);
  const attachmentMaxVideoBytes =
    selectedConfig?.environment.capabilities.attachmentUploads === true
      ? selectedConfig.environment.capabilities.fileAttachments?.maxUploadBytes
      : undefined;
  const footer = (
    <View
      className="flex-row items-center gap-3 border-t border-border-subtle bg-sheet-solid px-4 pt-3"
      style={{ paddingBottom: Math.max(insets.bottom, 12) }}
    >
      <CaptureAttachmentButton
        disabled={personal === null || isSaving || isImporting || !selectedTarget}
        existingCount={draft.attachments.length}
        supportsFiles={Boolean(selectedConfig?.environment.capabilities.fileAttachments)}
        maxFileBytes={selectedConfig?.environment.capabilities.fileAttachments?.maxUploadBytes}
        maxVideoBytes={attachmentMaxVideoBytes}
        trackImport={trackImport}
        onAddAttachments={(attachments) => {
          setSaved(false);
          setErrorMessage(null);
          return addAttachments(attachments, { text: draft.text, ...selectionRef.current });
        }}
        onError={setErrorMessage}
      />
      <View className="min-w-0 flex-1 flex-row items-center gap-2">
        <SymbolView
          name={selectedTarget?.destination.folderId === null ? "person.crop.circle" : "folder"}
          size={16}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
        <Text className="min-w-0 flex-1 text-sm text-foreground-muted" numberOfLines={1}>
          {isSaving
            ? "Saving…"
            : selectedTarget
              ? `Draft ${selectedTarget.destination.inPlace} · # to pick a folder`
              : selectedLabel}
        </Text>
      </View>
    </View>
  );

  return (
    <View className="flex-1 bg-sheet-solid">
      <NativeStackScreenOptions
        options={{
          title: "Capture",
          headerBackVisible: false,
          headerShown: Platform.OS !== "android",
        }}
      />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          title="Capture"
          onBack={requestDismiss}
          actions={[
            {
              accessibilityLabel: "Save capture",
              icon: "checkmark",
              disabled: saveDisabled,
              loading: isSaving,
              onPress: save,
            },
          ]}
        />
      ) : (
        <>
          <Toolbar placement="left">
            <Toolbar.Button
              icon="xmark"
              accessibilityLabel="Close capture"
              onPress={requestDismiss}
            />
          </Toolbar>
          <Toolbar placement="right">
            <Toolbar.Button
              label="Save"
              variant="done"
              accessibilityLabel="Save capture"
              disabled={saveDisabled}
              onPress={save}
            />
          </Toolbar>
        </>
      )}

      <KeyboardAvoidingView automaticOffset behavior="padding" className="flex-1">
        <ScrollView
          className="flex-1"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: Platform.OS === "android" ? 72 : 0 }}
        >
          <View className="gap-4 px-4 pt-4">
            {destinationUnavailable ? (
              <Text
                accessibilityLiveRegion="polite"
                className="rounded-xl bg-subtle px-4 py-3 text-sm text-foreground-muted"
              >
                That destination is no longer available.{" "}
                {draftKey
                  ? "Type # to choose another folder, or reconnect the original workspace."
                  : "Choose a destination below, or reconnect the original workspace."}
              </Text>
            ) : noPersonalDestination ? (
              <Text
                accessibilityLiveRegion="polite"
                className="rounded-xl bg-subtle px-4 py-3 text-sm text-foreground-muted"
              >
                {showPersonalLoading
                  ? "Loading your personal workspace…"
                  : "Your Personal top level isn't ready. Connect a Signalbox Cloud workspace, then try again."}
              </Text>
            ) : null}

            <ComposerEditor
              draftKey={draftKey}
              environmentId={draftEnvironmentId}
              ref={inputRef}
              autoFocus
              readOnly={isSaving || draftKey === null}
              multiline
              onChangeText={handleTextChange}
              onSelectionChange={handleSelectionChange}
              onPasteImages={(uris) => void handlePasteImages(uris)}
              placeholder="What's on your mind?"
              scrollEnabled
              style={{ minHeight: 136, opacity: personal === null ? 0.65 : 1 }}
              textStyle={{ textAlignVertical: "top" }}
              value={draft.text}
            />

            {suggestions.length > 0 ? (
              <View className="overflow-hidden rounded-2xl bg-grouped-card">
                {suggestions.map((target) => (
                  <Pressable
                    key={target.destination.key}
                    accessibilityRole="button"
                    accessibilityLabel={`${activeTrigger ? "Save in" : "Choose"} ${target.destination.label}`}
                    accessibilityState={{
                      selected: selectedTarget?.destination.key === target.destination.key,
                    }}
                    className="min-h-12 flex-row items-center gap-3 border-b border-border-subtle px-4 py-3 active:bg-subtle"
                    onPress={() => selectDestination(target)}
                  >
                    <SymbolView
                      name={target.destination.folderId === null ? "person.crop.circle" : "folder"}
                      size={17}
                      tintColorClassName="accent-icon-muted"
                      type="monochrome"
                    />
                    <View className="min-w-0 flex-1">
                      <Text className="text-sm font-t3-medium text-foreground" numberOfLines={1}>
                        {target.destination.label}
                      </Text>
                      {target.destination.detail ? (
                        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                          {target.destination.detail}
                        </Text>
                      ) : null}
                    </View>
                    {selectedTarget?.destination.key === target.destination.key ? (
                      <SymbolView name="checkmark" size={16} tintColorClassName="accent-icon" />
                    ) : null}
                  </Pressable>
                ))}
              </View>
            ) : activeTrigger ? (
              <Text className="text-sm text-foreground-muted">No matching folders.</Text>
            ) : null}

            {composerStripAttachments(draft.attachments).length > 0 && draftEnvironmentId ? (
              <ComposerAttachmentStrip
                environmentId={draftEnvironmentId}
                attachments={composerStripAttachments(draft.attachments)}
                imageSize={72}
                imageBorderRadius={16}
                onRemove={(attachmentId) => {
                  setSaved(false);
                  captureDraft.removeAttachment(attachmentId);
                }}
              />
            ) : null}

            {errorMessage ? (
              <Toast
                message="Capture needs attention"
                description={errorMessage}
                tone="danger"
                onDismiss={() => setErrorMessage(null)}
              />
            ) : saved && draftKey ? (
              <Toast
                message="Saved to drafts"
                action={selectedTarget ? { label: "Open draft", onPress: openSavedDraft } : undefined}
              />
            ) : null}
          </View>
        </ScrollView>
        {Platform.OS !== "android" ? footer : null}
      </KeyboardAvoidingView>
      {Platform.OS === "android" ? (
        <KeyboardStickyView
          className="absolute inset-x-0 bottom-0"
          offset={{ closed: 0, opened: 0 }}
        >
          {footer}
        </KeyboardStickyView>
      ) : null}
    </View>
  );
}
