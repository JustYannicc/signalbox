import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ScopedThreadRef,
  SourceControlPublishRepositoryResult,
  SourceControlRepositoryVisibility,
} from "@t3tools/contracts";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import * as Option from "effect/Option";
import { CheckIcon, GlobeIcon, LockIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useOpenLink } from "../../browser/useOpenLink";
import { useConnectCloudGitHub } from "../../github/CloudGitHubSettings";
import { useSourceControlPublishRepositoryAction } from "../../lib/sourceControlActions";
import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { GitHubIcon } from "../Icons";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { RadioGroup } from "../ui/radio-group";
import { Spinner } from "../ui/spinner";
import type { PublishableFolder } from "./usePublishableFolder";

const VISIBILITY_OPTIONS = [
  { value: "private", label: "Private", description: "Only people you invite", Icon: LockIcon },
  { value: "public", label: "Public", description: "Anyone on the web", Icon: GlobeIcon },
] as const;

const REPOSITORY_PATH = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

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

/** A repository name GitHub accepts, from the folder's name. */
function repositoryNameFor(folderName: string): string {
  return folderName
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|-+$/g, "");
}

/**
 * Publishes a cloud folder that has files but no remote as a new GitHub repository, created
 * with the requesting person's own connected GitHub.
 */
export function PublishFolderDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly folder: PublishableFolder;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPublished: () => void;
}) {
  const { environmentId, folder, onPublished } = props;
  const openLink = useOpenLink(props.threadRef);
  const connectGitHub = useConnectCloudGitHub(environmentId);
  const discovery = useEnvironmentQuery(
    props.open ? sourceControlEnvironment.discovery({ environmentId, input: {} }) : null,
  );
  const publish = useSourceControlPublishRepositoryAction({
    environmentId,
    cwd: folder.workspaceRoot,
  });
  const [repositoryOverride, setRepositoryOverride] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<SourceControlRepositoryVisibility>("private");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SourceControlPublishRepositoryResult | null>(null);
  const [connectStarted, setConnectStarted] = useState(false);

  // Connecting finishes in another tab or the system browser; coming back is when to look again.
  const refreshDiscovery = discovery.refresh;
  useEffect(() => {
    if (!props.open) return;
    window.addEventListener("focus", refreshDiscovery);
    return () => window.removeEventListener("focus", refreshDiscovery);
  }, [props.open, refreshDiscovery]);

  const github = discovery.data?.sourceControlProviders.find(
    (provider) => provider.kind === "github",
  );
  const account = github ? Option.getOrNull(github.auth.account) : null;
  const connected = github?.status === "available" && github.auth.status !== "unauthenticated";
  const repository =
    repositoryOverride ?? (account ? `${account}/${repositoryNameFor(folder.drive.name)}` : "");
  const canSubmit =
    connected && publish.isAllowed && !publish.isPending && REPOSITORY_PATH.test(repository.trim());

  const submit = () => {
    if (!canSubmit || github === undefined) return;
    setError(null);
    void (async () => {
      const outcome = await publish.run({
        provider: github.kind,
        repository: repository.trim(),
        visibility,
        // Cloud folders reach GitHub over HTTPS as the person publishing; nobody manages SSH keys.
        remoteName: "origin",
        protocol: "https",
      });
      if (outcome._tag === "Failure") {
        // The server resumes an interrupted publish, so trying again with the same input is safe.
        if (!isAtomCommandInterrupted(outcome)) {
          const cause = squashAtomCommandFailure(outcome);
          setError(
            cause instanceof Error && cause.message.trim()
              ? cause.message
              : "Something went wrong. Try again in a moment.",
          );
        }
        return;
      }
      setError(null);
      setResult(outcome.value);
      onPublished();
    })();
  };

  const handleOpenChange = (open: boolean) => {
    props.onOpenChange(open);
    if (open) return;
    setRepositoryOverride(null);
    setError(null);
    setResult(null);
    setConnectStarted(false);
  };

  const pushed = result?.status === "pushed";

  return (
    <Dialog open={props.open} onOpenChange={handleOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Publish to GitHub</DialogTitle>
          <DialogDescription>
            Creates a GitHub repository from {folder.drive.name}’s committed history and links the
            folder to it. Work threads have in progress stays on their own branches.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {result !== null ? (
            <div className="flex flex-col items-center gap-2 py-2 text-center">
              <span className="grid size-8 place-items-center rounded-full bg-success/15 text-success">
                <CheckIcon className="size-4" aria-hidden />
              </span>
              <h3 className="text-sm font-semibold text-foreground">
                {pushed ? "Published" : "Repository ready"}
              </h3>
              <p className="max-w-xs text-pretty text-xs text-muted-foreground">
                {publishedCopy(folder.drive.name, result)}
              </p>
            </div>
          ) : discovery.data === null && discovery.error !== null ? (
            <Alert variant="error">
              <AlertTitle>Couldn’t check your GitHub connection</AlertTitle>
              <AlertDescription>{discovery.error}</AlertDescription>
            </Alert>
          ) : discovery.data === null ? (
            <div
              role="status"
              className="flex items-center gap-2 py-2 text-xs text-muted-foreground"
            >
              <Spinner size="sm" aria-hidden />
              Checking your GitHub connection…
            </div>
          ) : github === undefined || github.status !== "available" ? (
            <Alert variant="warning">
              <AlertTitle>GitHub isn’t available here</AlertTitle>
              <AlertDescription>
                {github?.installHint ?? "This Signalbox Cloud can’t reach GitHub right now."}
              </AlertDescription>
            </Alert>
          ) : !connected ? (
            <div className="flex items-start gap-3 rounded-lg border border-border bg-background px-3 py-3 dark:border-transparent dark:bg-white/[0.035]">
              <GitHubIcon className="mt-0.5 size-5 shrink-0" aria-hidden />
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-medium text-foreground">Connect your GitHub</p>
                <p className="text-pretty text-xs text-muted-foreground">
                  {connectStarted
                    ? "Finish connecting in the browser, then come back. This updates on its own."
                    : "Signalbox creates the repository as you, under your account or an organization you can create repositories in."}
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-5">
              <div className="space-y-2">
                <label htmlFor="publish-folder-repository" className="text-xs font-medium">
                  Repository
                </label>
                <div className="flex items-stretch overflow-hidden rounded-md border border-input bg-background focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-ring">
                  <span className="flex shrink-0 items-center gap-1.5 border-r border-input bg-muted/50 px-2.5 font-mono text-xs text-muted-foreground">
                    <GitHubIcon className="size-3.5" aria-hidden />
                    github.com/
                  </span>
                  <input
                    id="publish-folder-repository"
                    value={repository}
                    onChange={(event) => setRepositoryOverride(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      submit();
                    }}
                    placeholder="owner/name"
                    spellCheck={false}
                    autoCapitalize="off"
                    disabled={publish.isPending}
                    className="w-full bg-transparent px-3 py-2 font-mono text-sm placeholder:text-muted-foreground/60 focus:outline-none"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  {account ? `Created as @${account}. ` : null}
                  To publish under an organization, put its name before the slash.
                </p>
              </div>
              <div className="space-y-2">
                <span id="publish-folder-visibility" className="text-xs font-medium">
                  Visibility
                </span>
                <RadioGroup
                  value={visibility}
                  onValueChange={(value) =>
                    setVisibility(value as SourceControlRepositoryVisibility)
                  }
                  aria-labelledby="publish-folder-visibility"
                  disabled={publish.isPending}
                  className="grid grid-cols-2"
                >
                  {VISIBILITY_OPTIONS.map((option) => (
                    <RadioPrimitive.Root
                      key={option.value}
                      value={option.value}
                      className={cn(
                        "relative flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-left outline-none transition-[background-color,border-color,box-shadow]",
                        "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                        visibility === option.value
                          ? "border-primary bg-background shadow-sm ring-2 ring-inset ring-primary/35 dark:border-transparent dark:bg-primary/10 dark:shadow-none dark:ring-1 dark:ring-primary/30"
                          : "border-border bg-background hover:border-foreground/20 hover:bg-muted/50 dark:border-transparent dark:bg-white/[0.035] dark:hover:bg-accent",
                      )}
                    >
                      <option.Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-foreground">
                          {option.label}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {option.description}
                        </span>
                      </span>
                    </RadioPrimitive.Root>
                  ))}
                </RadioGroup>
              </div>
              {publish.isPending ? (
                <div
                  role="status"
                  aria-live="polite"
                  className="flex items-center gap-2 rounded-md border border-input bg-muted/40 px-3 py-2 text-xs text-muted-foreground dark:border-transparent dark:bg-white/[0.035]"
                >
                  <Spinner size="sm" aria-hidden />
                  Creating {repository.trim()} and pushing the folder’s history…
                </div>
              ) : error ? (
                <Alert variant="error">
                  <AlertTitle>Couldn’t publish</AlertTitle>
                  <AlertDescription>
                    {error} The folder is untouched, and trying again picks up where this stopped.
                  </AlertDescription>
                </Alert>
              ) : null}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          {result !== null ? (
            <>
              <Button
                variant="outline"
                onClick={() => void openLink(result.repository.url).catch(() => undefined)}
              >
                Open on GitHub
              </Button>
              <Button onClick={() => handleOpenChange(false)}>Done</Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                {publish.isPending ? "Close" : "Cancel"}
              </Button>
              {discovery.data === null && discovery.error !== null ? (
                <Button onClick={discovery.refresh}>Check again</Button>
              ) : github?.status === "available" && !connected ? (
                <Button
                  disabled={connectGitHub === null}
                  onClick={() => {
                    connectGitHub?.();
                    setConnectStarted(true);
                  }}
                >
                  <GitHubIcon aria-hidden />
                  {connectStarted ? "Open GitHub again" : "Connect GitHub"}
                </Button>
              ) : connected ? (
                <Button disabled={!canSubmit} onClick={submit}>
                  {publish.isPending ? <Spinner size="sm" aria-hidden /> : null}
                  {publish.isPending ? "Publishing…" : error ? "Try again" : "Publish"}
                </Button>
              ) : null}
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
