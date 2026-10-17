/**
 * A level's secrets (#395): the 1Password Environment its threads load when
 * they start, and the user's service account token that reads it. The token
 * is one per user, so connecting, replacing or disconnecting it here applies
 * to every folder. Neither the token nor any value ever comes back to show.
 */
import { useAtomValue } from "@effect/atom-react";
import { useId, useState, type FormEvent } from "react";

import { environmentFoldersAtom } from "../../../state/signalboxFolders";
import { formatRelativeTimeLabel } from "../../../timestampFormat";
import { Button } from "../../ui/button";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { closeFolderDialog, type FolderDialog } from "./folderDialogStore";
import {
  formatSources,
  levelSecrets,
  planSecretsSave,
  secretSourcesAbove,
} from "./folderSecretsModel";
import { useFolderCommands, type Attempt } from "./useFolderCommands";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";

type TokenMode = "connected" | "replace" | "disconnect";
type Action = "save" | "remove" | "disconnect";

export function FolderSecretsDialog(props: { dialog: Extract<FolderDialog, { kind: "secrets" }> }) {
  const { dialog } = props;
  const formId = useId();
  const commands = useFolderCommands();
  const snapshot = useAtomValue(environmentFoldersAtom).get(dialog.environmentId)?.snapshot;
  const current = snapshot ? levelSecrets(snapshot, dialog.level) : null;
  const above = snapshot ? secretSourcesAbove(snapshot, dialog.level) : [];
  const connectedAt = snapshot?.onePassword?.connectedAt ?? null;

  const [environmentId, setEnvironmentId] = useState<string>(current ?? "");
  const [token, setToken] = useState("");
  const [tokenMode, setTokenMode] = useState<TokenMode>("connected");
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<Action | null>(null);
  const pending = running !== null;
  const askToken = connectedAt === null || tokenMode === "replace";

  /** Runs one action at a time; a failed step shows why and stops it. True closes the dialog. */
  const run = async (
    action: Action,
    steps: (step: (attempt: Attempt) => Promise<boolean>) => Promise<boolean>,
  ) => {
    if (pending) return;
    setRunning(action);
    setError(null);
    const step = async (attempt: Attempt) => {
      const failure = await attempt;
      if (failure !== null) setError(failure.error);
      return failure === null;
    };
    const done = await settlePromise(() => steps(step));
    setRunning(null);
    if (done._tag === "Success" && done.value) closeFolderDialog();
  };

  const save = (event?: FormEvent) => {
    event?.preventDefault();
    const plan = planSecretsSave({
      current,
      environmentId,
      token: askToken ? token : null,
      connected: connectedAt !== null,
    });
    if ("error" in plan) return setError(plan.error);
    if (plan.connect === null && plan.environmentId === undefined) return closeFolderDialog();
    void run("save", async (step) => {
      if (plan.connect !== null) {
        if (!(await step(commands.setOnePassword(dialog.environmentId, plan.connect)))) {
          return false;
        }
        setToken("");
        setTokenMode("connected");
      }
      return plan.environmentId === undefined
        ? true
        : step(commands.setSecrets(dialog.environmentId, dialog.level, plan.environmentId));
    });
  };

  const remove = () =>
    void run("remove", (step) =>
      step(commands.setSecrets(dialog.environmentId, dialog.level, null)),
    );

  // Stays open: what's left is the way to connect again.
  const disconnect = () =>
    void run("disconnect", async (step) => {
      if (await step(commands.setOnePassword(dialog.environmentId, null))) {
        setTokenMode("connected");
      }
      return false;
    });

  const named = environmentId.trim().length > 0;

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {dialog.name === null ? "Top-level secrets" : `Secrets for “${dialog.name}”`}
        </DialogTitle>
        <DialogDescription>
          {dialog.name === null
            ? "Every thread gets this 1Password Environment's variables when it starts."
            : "Threads in this folder and below get this 1Password Environment's variables when they start."}{" "}
          Values never show in Signalbox.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <form id={formId} className="grid gap-5" onSubmit={save}>
          <div className="grid gap-1.5">
            <Label htmlFor={`${formId}-environment`}>1Password Environment ID</Label>
            <Input
              id={`${formId}-environment`}
              autoComplete="off"
              autoFocus={current === null}
              disabled={pending}
              placeholder="Environment ID"
              spellCheck={false}
              value={environmentId}
              onChange={(event) => setEnvironmentId(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              In the 1Password app: Developer › View Environments › Manage environment › Copy
              environment ID.
            </p>
            {above.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                {named
                  ? `Threads here also get secrets from ${formatSources(above)}. Where names clash, this folder's win.`
                  : `Threads here already get secrets from ${formatSources(above)}.`}
              </p>
            ) : null}
          </div>

          {askToken ? (
            <div className="grid gap-1.5">
              <Label htmlFor={`${formId}-token`}>Service account token</Label>
              <Input
                id={`${formId}-token`}
                autoComplete="off"
                autoFocus={tokenMode === "replace"}
                disabled={pending}
                placeholder="ops_…"
                spellCheck={false}
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                1Password shows it once, when you create a service account with read access to this
                Environment. One token covers all your folders.
              </p>
              {connectedAt !== null ? (
                <div>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => {
                      setToken("");
                      setTokenMode("connected");
                    }}
                  >
                    Keep current token
                  </Button>
                </div>
              ) : null}
            </div>
          ) : tokenMode === "disconnect" ? (
            <div className="grid gap-2 rounded-lg border px-3 py-2.5">
              <p className="text-sm">
                Disconnect 1Password? Secrets stop loading in all your folders until you connect it
                again.
              </p>
              <div className="flex justify-end gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={pending}
                  onClick={() => setTokenMode("connected")}
                >
                  Cancel
                </Button>
                <Button size="xs" variant="destructive" disabled={pending} onClick={disconnect}>
                  {running === "disconnect" ? "Disconnecting…" : "Disconnect"}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-lg border px-3 py-2">
              <p className="min-w-0 flex-1 text-sm">
                1Password connected
                {connectedAt === null ? null : (
                  <span className="text-muted-foreground">
                    {" "}
                    · {formatRelativeTimeLabel(new Date(connectedAt).toISOString())}
                  </span>
                )}
              </p>
              <Button
                size="xs"
                variant="outline"
                disabled={pending}
                onClick={() => setTokenMode("replace")}
              >
                Replace token
              </Button>
              <Button
                size="xs"
                variant="ghost-destructive"
                disabled={pending}
                onClick={() => setTokenMode("disconnect")}
              >
                Disconnect
              </Button>
            </div>
          )}

          {error === null ? null : (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
        </form>
      </DialogPanel>
      <DialogFooter>
        {current === null ? null : (
          <Button
            className="sm:me-auto"
            variant="ghost-destructive"
            disabled={pending}
            onClick={remove}
          >
            {running === "remove" ? "Removing…" : "Remove Environment"}
          </Button>
        )}
        <Button variant="outline" disabled={pending} onClick={closeFolderDialog}>
          Cancel
        </Button>
        <Button type="submit" form={formId} disabled={pending}>
          {running === "save" ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </>
  );
}
