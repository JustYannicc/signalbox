// signalbox: publishes a cloud folder with files and no remote as a new GitHub repository (#810).
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthSourceControlWriteScope,
  EnvironmentId,
  ProjectId,
  type SourceControlPublishRepositoryResult,
  type SourceControlRepositoryVisibility,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import Constants from "expo-constants";
import * as WebBrowser from "expo-web-browser";
import * as Option from "effect/Option";
import { useCallback, useEffect, useState } from "react";
import { AppState, Linking, Platform, ScrollView, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AndroidSheetHeader } from "../../components/ui/AndroidScreenHeader";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { Notice } from "../../components/ui/Notice";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { useResubscribeEnvironmentThread } from "../../state/threads";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { vcsEnvironment } from "../../state/vcs";
import { parseGitHubConnectReturn, startGitHubConnect } from "../account/accountApi";
import { accountReturnUrl } from "../account/signInLogic";
import { SheetActionButton } from "../threads/git/gitSheetComponents";
import { usePublishableProject } from "./usePublishableFolder";

type PublishFolderSheetProps = StaticScreenProps<{
  readonly environmentId: string;
  /** The folder's project; its root is what gets published. */
  readonly projectId: string;
  /** The thread it was opened from, whose git status then refreshes too. */
  readonly threadId?: string;
}>;

const VISIBILITY_OPTIONS = [
  { value: "private", label: "Private" },
  { value: "public", label: "Public" },
] as const;

const REPOSITORY_PATH = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** Where connecting GitHub comes back to; null in a build that can't receive it. */
const CONNECT_RETURN_URL = accountReturnUrl(Constants.expoConfig?.scheme);

function repositoryNameFor(folderName: string): string {
  return folderName
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|-+$/g, "");
}

function failureMessage(cause: unknown): string {
  return cause instanceof Error && cause.message.trim()
    ? cause.message
    : "Something went wrong. Try again in a moment.";
}

/**
 * What publishing did. Only the folder's committed history goes up; work threads have in
 * progress stays on their own branches. A folder with no committed history yet gets an empty
 * repository that its first commit lands in.
 */
function publishedCopy(folderName: string, result: SourceControlPublishRepositoryResult): string {
  const repository = result.repository.nameWithOwner;
  return result.status === "pushed"
    ? `${repository} now holds ${folderName}’s committed history. Work threads have in progress stays on their own branches.`
    : `${repository} is linked to ${folderName}. The folder has no committed history yet, so it starts empty until the first commit.`;
}

/** Publishes a cloud folder as a new GitHub repository, with the person's own connected GitHub. */
export function PublishFolderSheet(props: PublishFolderSheetProps) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const folder = usePublishableProject(environmentId, ProjectId.make(props.route.params.projectId));
  const canWrite = useEnvironmentScope(environmentId, AuthSourceControlWriteScope);
  const connection = usePreparedConnection(environmentId);
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const discovery = useEnvironmentQuery(
    sourceControlEnvironment.discovery({ environmentId, input: {} }),
  );
  const folderStatus = useEnvironmentQuery(
    folder === null
      ? null
      : vcsEnvironment.status({ environmentId, input: { cwd: folder.workspaceRoot } }),
  );
  const threadStatus = useEnvironmentQuery(
    props.route.params.threadId === undefined || selectedThreadCwd === null
      ? null
      : vcsEnvironment.status({ environmentId, input: { cwd: selectedThreadCwd } }),
  );
  const resubscribeThread = useResubscribeEnvironmentThread(
    environmentId,
    props.route.params.threadId === undefined ? null : ThreadId.make(props.route.params.threadId),
  );
  const publishRepository = useAtomCommand(sourceControlEnvironment.publishRepository, {
    reportFailure: false,
  });
  const [repositoryOverride, setRepositoryOverride] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<SourceControlRepositoryVisibility>("private");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SourceControlPublishRepositoryResult | null>(null);
  const [connectState, setConnectState] = useState<
    | { readonly _tag: "idle" }
    | { readonly _tag: "pending" }
    | { readonly _tag: "failed"; readonly message: string }
  >({ _tag: "idle" });

  // Connecting finishes in a browser; coming back to the app is when to look again.
  const refreshDiscovery = discovery.refresh;
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refreshDiscovery();
    });
    return () => subscription.remove();
  }, [refreshDiscovery]);

  const github = discovery.data?.sourceControlProviders.find(
    (provider) => provider.kind === "github",
  );
  const account = github ? Option.getOrNull(github.auth.account) : null;
  const connected = github?.status === "available" && github.auth.status !== "unauthenticated";
  const repository =
    repositoryOverride ??
    (account && folder ? `${account}/${repositoryNameFor(folder.drive.name)}` : "");
  const canSubmit =
    folder !== null && connected && canWrite && !pending && REPOSITORY_PATH.test(repository.trim());

  const prepared = Option.getOrNull(connection);
  const token =
    prepared?.httpAuthorization?._tag === "Bearer" ? prepared.httpAuthorization.token : null;
  const httpBaseUrl = prepared?.httpBaseUrl ?? null;
  const connectGitHub = useCallback(async () => {
    const returnUrl = CONNECT_RETURN_URL;
    if (httpBaseUrl === null || token === null || returnUrl === null) return;
    setConnectState({ _tag: "pending" });
    try {
      const url = await startGitHubConnect(httpBaseUrl, token, returnUrl);
      const opened = await WebBrowser.openAuthSessionAsync(url, returnUrl);
      // Closing the browser sheet is a cancel, not an error.
      const outcome =
        opened.type === "success" ? parseGitHubConnectReturn(opened.url) : "cancelled";
      setConnectState(
        outcome === "failed"
          ? { _tag: "failed", message: "GitHub didn’t connect. Try again." }
          : { _tag: "idle" },
      );
    } catch (cause) {
      setConnectState({
        _tag: "failed",
        message:
          cause instanceof Error && cause.message.trim()
            ? cause.message
            : "Couldn’t connect GitHub. Try again.",
      });
    } finally {
      refreshDiscovery();
    }
  }, [httpBaseUrl, refreshDiscovery, token]);

  const submit = useCallback(async () => {
    if (!canSubmit || github === undefined || folder === null) return;
    setPending(true);
    setError(null);
    const outcome = await publishRepository({
      environmentId,
      input: {
        cwd: folder.workspaceRoot,
        provider: github.kind,
        repository: repository.trim(),
        visibility,
        // Cloud folders reach GitHub over HTTPS as the person publishing.
        remoteName: "origin",
        protocol: "https",
      },
    });
    setPending(false);
    if (outcome._tag === "Failure") {
      // The server resumes an interrupted publish, so trying again with the same input is safe.
      if (!isAtomCommandInterrupted(outcome)) {
        setError(failureMessage(squashAtomCommandFailure(outcome)));
      }
      return;
    }
    setResult(outcome.value);
    // The thread moves onto its own branch when the server next reads it; read it now.
    resubscribeThread();
    folderStatus.refresh();
    threadStatus.refresh();
  }, [
    canSubmit,
    environmentId,
    folder,
    folderStatus,
    github,
    publishRepository,
    repository,
    resubscribeThread,
    threadStatus,
    visibility,
  ]);

  const folderName = folder?.drive.name ?? "this folder";
  // Opened from a folder menu, which can't tell whether the folder already has a remote.
  const alreadyPublished = result === null && folderStatus.data?.isRepo === true;
  const title =
    result === null
      ? alreadyPublished
        ? "Already on GitHub"
        : "Publish to GitHub"
      : result.status === "pushed"
        ? "Published"
        : "Repository ready";
  const description =
    result !== null
      ? publishedCopy(folderName, result)
      : alreadyPublished
        ? `${folderName} is already linked to a repository. Threads here push their branches to it.`
        : `Creates a GitHub repository from ${folderName}’s committed history and links the folder to it. Work threads have in progress stays on their own branches.`;

  return (
    <View
      collapsable={false}
      className="bg-sheet ios:flex-1"
      style={Platform.OS === "android" ? { maxHeight: windowHeight * 0.92 } : undefined}
    >
      {Platform.OS === "android" ? (
        <NativeStackScreenOptions
          options={{ sheetCornerRadius: 28, sheetAllowedDetents: "fitToContents" }}
        />
      ) : null}
      {Platform.OS === "android" ? (
        <AndroidSheetHeader title={title} onBack={() => navigation.goBack()} hideBottomBorder />
      ) : (
        <View className="min-h-4 pt-2" />
      )}
      <ScreenContent fitToContents>
        <ScrollView
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
          className="android:shrink android:grow-0 ios:flex-1"
          showsVerticalScrollIndicator={false}
          contentContainerClassName="gap-3 android:p-2 ios:px-5"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 8 }}
        >
          <View className="android:gap-2 android:rounded-[20px] android:bg-card android:p-3 ios:items-center ios:gap-1 ios:pb-2 ios:pt-4">
            {Platform.OS !== "android" ? (
              <Text className="text-3xl font-t3-bold ios:text-center">{title}</Text>
            ) : null}
            <Text className="text-foreground-secondary leading-normal android:text-base ios:text-center ios:text-sm ios:font-medium">
              {description}
            </Text>
          </View>

          {result !== null ? (
            <View className="flex-row gap-3">
              <SheetActionButton
                icon="arrow.up.right"
                label="Open on GitHub"
                onPress={() => void Linking.openURL(result.repository.url).catch(() => {})}
              />
              <SheetActionButton
                icon="checkmark.circle"
                label="Done"
                tone="primary"
                onPress={() => navigation.goBack()}
              />
            </View>
          ) : folder === null ? (
            <Notice message="Only a folder’s managers can publish it to GitHub." />
          ) : alreadyPublished ? (
            <SheetActionButton
              icon="checkmark.circle"
              label="Done"
              tone="primary"
              onPress={() => navigation.goBack()}
            />
          ) : discovery.data === null && discovery.error !== null ? (
            <>
              <ErrorBanner message={discovery.error} />
              <SheetActionButton
                icon="arrow.clockwise"
                label="Check again"
                onPress={refreshDiscovery}
              />
            </>
          ) : discovery.data === null ? (
            <AppActivityIndicator colorClassName="accent-icon-muted" />
          ) : github === undefined || github.status !== "available" ? (
            <Notice message={github?.installHint ?? "This Signalbox Cloud can’t reach GitHub."} />
          ) : !connected ? (
            <>
              <Notice message="Signalbox creates the repository as you, under your account or an organization you can create repositories in." />
              {connectState._tag === "failed" ? (
                <ErrorBanner message={connectState.message} />
              ) : null}
              <SheetActionButton
                icon="person.crop.circle"
                label={connectState._tag === "pending" ? "Connecting…" : "Connect GitHub"}
                tone="primary"
                disabled={
                  connectState._tag === "pending" ||
                  httpBaseUrl === null ||
                  token === null ||
                  CONNECT_RETURN_URL === null
                }
                onPress={() => void connectGitHub()}
              />
            </>
          ) : (
            <>
              <View className="gap-1.5">
                <Text className="text-foreground-muted text-2xs font-t3-bold tracking-[0.9px] uppercase">
                  github.com/
                </Text>
                <TextInput
                  className="h-12 min-h-12 rounded-[24px] px-4 py-0 font-mono text-base leading-snug"
                  value={repository}
                  onChangeText={setRepositoryOverride}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!pending}
                  placeholder="owner/name"
                  returnKeyType="go"
                  onSubmitEditing={() => void submit()}
                  accessibilityLabel="Repository"
                />
                <Text className="text-foreground-muted text-xs leading-snug">
                  {account ? `Created as @${account}. ` : null}
                  Put an organization before the slash to publish there.
                </Text>
              </View>
              <SegmentedControl
                options={VISIBILITY_OPTIONS}
                selected={visibility}
                onSelect={setVisibility}
              />
              {pending ? (
                <View
                  accessibilityLiveRegion="polite"
                  className="flex-row items-center gap-2 rounded-[18px] bg-card px-4 py-3"
                >
                  <AppActivityIndicator size="small" colorClassName="accent-icon-muted" />
                  <Text className="text-foreground-secondary flex-1 text-sm">
                    Creating {repository.trim()} and pushing the folder’s history…
                  </Text>
                </View>
              ) : error ? (
                <ErrorBanner
                  message={`${error} The folder is untouched, and trying again picks up where this stopped.`}
                />
              ) : null}
              <SheetActionButton
                icon="arrow.up.circle"
                label={pending ? "Publishing…" : error ? "Try again" : "Publish"}
                tone="primary"
                disabled={!canSubmit}
                onPress={() => void submit()}
              />
            </>
          )}
        </ScrollView>
      </ScreenContent>
    </View>
  );
}
