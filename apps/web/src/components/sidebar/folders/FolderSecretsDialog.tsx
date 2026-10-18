/**
 * A level's secrets (#395): the 1Password Environment its threads load when
 * they start, and the user's service account token that reads it. The token
 * is one per user, so connecting, replacing or disconnecting it here applies
 * to every folder. Neither the token nor any value ever comes back to show.
 */
import { useAtomValue } from "@effect/atom-react";
import { useId, useState, type FormEvent } from "react";
import {
  addSubfolderSecretName,
  isSecretEnvironmentName,
  resetSubfolderSecretNamesForEnvironment,
} from "@t3tools/client-runtime/state/folderSecrets";

import { environmentFoldersAtom } from "../../../state/signalboxFolders";
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
import { FolderOnePasswordConnectionField } from "./FolderOnePasswordConnectionField";
import { FolderSecretSubfoldersField } from "./FolderSecretSubfoldersField";
import {
  formatSources,
  levelSecrets,
  planSecretsSave,
  secretSourcesAbove,
} from "./folderSecretsModel";
import { useFolderCommands, type Attempt } from "./useFolderCommands";

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

  const [environmentId, setEnvironmentId] = useState<string>(current?.environmentId ?? "");
  const [keyName, setKeyName] = useState("");
  const [keyNames, setKeyNames] = useState<ReadonlyArray<string>>(current?.includeSubfolders ?? []);
  const [includedNames, setIncludedNames] = useState<ReadonlyArray<string>>(
    current?.includeSubfolders ?? [],
  );
  const [token, setToken] = useState("");
  const [tokenMode, setTokenMode] = useState<TokenMode>("connected");
  const [error, setError] = useState<string | null>(null);
  const [keyNameError, setKeyNameError] = useState<string | null>(null);
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
    await (async () => {
      if (await steps(step)) closeFolderDialog();
    })().finally(() => {
      setRunning(null);
    });
  };

  const save = (event?: FormEvent) => {
    event?.preventDefault();
    const plan = planSecretsSave({
      current,
      environmentId,
      includeSubfolders: includedNames,
      token: askToken ? token : null,
      connected: connectedAt !== null,
    });
    if ("error" in plan) return setError(plan.error);
    if (plan.connect === null && plan.secrets === undefined) return closeFolderDialog();
    void run("save", async (step) => {
      if (plan.connect !== null) {
        if (!(await step(commands.setOnePassword(dialog.environmentId, plan.connect)))) {
          return false;
        }
        setToken("");
        setTokenMode("connected");
      }
      return plan.secrets === undefined
        ? true
        : step(commands.setSecrets(dialog.environmentId, dialog.level, plan.secrets));
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

  const addKeyName = () => {
    const name = keyName.trim();
    if (name.length === 0) return setKeyNameError("Enter an environment variable name.");
    if (!isSecretEnvironmentName(name)) {
      return setKeyNameError(
        "Use letters, numbers and underscores; start with a letter or underscore.",
      );
    }
    const next = addSubfolderSecretName(keyNames, name);
    if (next === keyNames) return setKeyNameError("That name is already listed.");
    setKeyNames(next);
    setKeyName("");
    setKeyNameError(null);
  };

  const updateEnvironmentId = (value: string) => {
    setKeyNames((names) => resetSubfolderSecretNamesForEnvironment(environmentId, value, names));
    setIncludedNames((names) =>
      resetSubfolderSecretNamesForEnvironment(environmentId, value, names),
    );
    setKeyName("");
    setKeyNameError(null);
    setError(null);
    setEnvironmentId(value);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {dialog.name === null ? "Top-level secrets" : `Secrets for “${dialog.name}”`}
        </DialogTitle>
        <DialogDescription>
          {dialog.name === null
            ? named
              ? "Threads at this level get this 1Password Environment's variables. Child folders only get names you include below."
              : "Add a 1Password Environment to load its variables into threads at this level."
            : named
              ? "Threads in this folder get this 1Password Environment's variables. Child folders only get names you include below."
              : "Add a 1Password Environment to load its variables into threads in this folder."}{" "}
          This dialog shows names only, not Environment values.
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
              onChange={(event) => updateEnvironmentId(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              In the 1Password app: Developer › View Environments › Manage environment › Copy
              environment ID.
            </p>
            {above.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                {named
                  ? `Threads here also get secrets from ${formatSources(above)}. This level wins when names clash.`
                  : `Threads here already get secrets from ${formatSources(above)}.`}
              </p>
            ) : null}
          </div>

          <FolderSecretSubfoldersField
            formId={formId}
            topLevel={dialog.level._tag === "top"}
            named={named}
            pending={pending}
            keyName={keyName}
            keyNames={keyNames}
            includedNames={includedNames}
            keyNameError={keyNameError}
            setIncludedNames={setIncludedNames}
            onKeyNameChange={(value) => {
              setKeyName(value);
              setKeyNameError(null);
            }}
            onAddKeyName={addKeyName}
          />

          <FolderOnePasswordConnectionField
            formId={formId}
            connectedAt={connectedAt}
            askToken={askToken}
            tokenMode={tokenMode}
            token={token}
            pending={pending}
            disconnecting={running === "disconnect"}
            onTokenChange={(value) => {
              setToken(value);
              setError(null);
            }}
            onKeepCurrentToken={() => {
              setToken("");
              setTokenMode("connected");
            }}
            onReplaceToken={() => setTokenMode("replace")}
            onStartDisconnect={() => setTokenMode("disconnect")}
            onConfirmDisconnect={disconnect}
            onCancelDisconnect={() => setTokenMode("connected")}
          />

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
