import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import type { AccountHubConnection, AccountHubImportResult } from "@t3tools/contracts/accountHub";
import { useEffect, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Radio, RadioGroup } from "../ui/radio-group";
import { toastManager } from "../ui/toast";

const failureText = (result: Parameters<typeof squashAtomCommandFailure>[0], fallback: string) => {
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error ? failure.message : fallback;
};

function importSummary(result: AccountHubImportResult): string {
  const parts = [
    result.imported.length > 0 ? `${result.imported.length} imported` : null,
    result.skipped.length > 0 ? `${result.skipped.length} already here` : null,
    result.failed.length > 0 ? `${result.failed.length} failed` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "That CLIProxyAPI has no accounts.";
}

/**
 * Where pooled accounts live: the CLIProxyAPI Signalbox runs, or one the user
 * already runs. Also imports another instance's accounts into the current hub.
 * Keys are sent once and kept on the server.
 */
export function AccountHubConnectionDialog({
  environmentId,
  initialTab,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly initialTab: "connect" | "import";
  readonly onClose: () => void;
}) {
  const getConnection = useAtomCommand(serverEnvironment.getAccountHubConnection, {
    reportFailure: false,
  });
  const setConnection = useAtomCommand(serverEnvironment.setAccountHubConnection, {
    reportFailure: false,
  });
  const importAccounts = useAtomCommand(serverEnvironment.importAccountHubAccounts, {
    reportFailure: false,
  });
  const [current, setCurrent] = useState<AccountHubConnection | null>(null);
  const [mode, setMode] = useState<"managed" | "external">("managed");
  const [url, setUrl] = useState("");
  const [managementKey, setManagementKey] = useState("");
  const [clientKey, setClientKey] = useState("");
  const [importUrl, setImportUrl] = useState("");
  const [importKey, setImportKey] = useState("");
  const [removeFromSource, setRemoveFromSource] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imported, setImported] = useState<AccountHubImportResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getConnection({ environmentId, input: undefined }).then((result) => {
      if (cancelled || result._tag !== "Success") return;
      setCurrent(result.value);
      setMode(result.value.mode);
      if (result.value.mode === "external") setUrl(result.value.url);
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, getConnection]);

  const saveConnection = async () => {
    setPending(true);
    setError(null);
    const result = await setConnection({
      environmentId,
      input:
        mode === "managed"
          ? { mode: "managed" }
          : {
              mode: "external",
              url: url.trim(),
              managementKey: managementKey.trim(),
              clientKey: clientKey.trim(),
            },
    });
    setPending(false);
    if (result._tag !== "Success") {
      setError(failureText(result, "Could not connect to that CLIProxyAPI."));
      return;
    }
    toastManager.add({
      type: "success",
      title:
        result.value.mode === "external"
          ? "Using your CLIProxyAPI"
          : "Signalbox runs the account hub again",
    });
    onClose();
  };

  const runImport = async () => {
    setPending(true);
    setError(null);
    setImported(null);
    const result = await importAccounts({
      environmentId,
      input: { url: importUrl.trim(), managementKey: importKey.trim(), removeFromSource },
    });
    setPending(false);
    if (result._tag !== "Success") {
      setError(failureText(result, "Could not import from that CLIProxyAPI."));
      return;
    }
    setImported(result.value);
  };

  const connectReady =
    mode === "managed"
      ? current?.mode !== "managed"
      : url.trim() !== "" && managementKey.trim() !== "" && clientKey.trim() !== "";
  const importReady = importUrl.trim() !== "" && importKey.trim() !== "";

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-lg">
        {initialTab === "connect" ? (
          <>
            <DialogHeader>
              <DialogTitle>Account hub</DialogTitle>
              <DialogDescription>
                Pooled accounts run through CLIProxyAPI. Signalbox runs one for you, or use one you
                already run.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <form
                className="grid gap-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (connectReady && !pending) void saveConnection();
                }}
              >
                <RadioGroup
                  value={mode}
                  onValueChange={(value) => setMode(value === "external" ? "external" : "managed")}
                >
                  <label className="flex items-center gap-2 text-sm">
                    <Radio value="managed" />
                    Signalbox runs it
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <Radio value="external" />
                    Use my CLIProxyAPI
                  </label>
                </RadioGroup>
                {mode === "external" ? (
                  <>
                    <div className="grid gap-1.5">
                      <Label htmlFor="hub-url">URL</Label>
                      <Input
                        id="hub-url"
                        placeholder="https://cliproxyapi.example.com"
                        value={url}
                        onChange={(event) => setUrl(event.target.value)}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="hub-management-key">Management key</Label>
                      <Input
                        id="hub-management-key"
                        type="password"
                        autoComplete="off"
                        value={managementKey}
                        onChange={(event) => setManagementKey(event.target.value)}
                      />
                    </div>
                    <div className="grid gap-1.5">
                      <Label htmlFor="hub-client-key">API key</Label>
                      <Input
                        id="hub-client-key"
                        type="password"
                        autoComplete="off"
                        placeholder="One of its access api-keys"
                        value={clientKey}
                        onChange={(event) => setClientKey(event.target.value)}
                      />
                    </div>
                  </>
                ) : null}
                {error ? <p className="text-xs text-destructive">{error}</p> : null}
              </form>
            </DialogPanel>
            <DialogFooter variant="bare">
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button disabled={!connectReady || pending} onClick={() => void saveConnection()}>
                {pending ? "Checking…" : "Save"}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Import from CLIProxyAPI</DialogTitle>
              <DialogDescription>
                Copy the accounts of a CLIProxyAPI you already run into the account hub.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <form
                className="grid gap-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (importReady && !pending) void runImport();
                }}
              >
                <div className="grid gap-1.5">
                  <Label htmlFor="import-url">URL</Label>
                  <Input
                    id="import-url"
                    placeholder="https://cliproxyapi.example.com"
                    value={importUrl}
                    onChange={(event) => setImportUrl(event.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="import-key">Management key</Label>
                  <Input
                    id="import-key"
                    type="password"
                    autoComplete="off"
                    value={importKey}
                    onChange={(event) => setImportKey(event.target.value)}
                  />
                </div>
                <label className="flex items-start gap-2 text-sm">
                  <Checkbox
                    checked={removeFromSource}
                    onCheckedChange={(checked) => setRemoveFromSource(checked === true)}
                  />
                  <span className="grid gap-0.5">
                    Remove them from that CLIProxyAPI
                    <span className="text-xs text-muted-foreground">
                      Two hubs refreshing the same account sign each other out.
                    </span>
                  </span>
                </label>
                {imported ? (
                  <p className="text-xs text-muted-foreground">{importSummary(imported)}</p>
                ) : null}
                {imported?.failed.map((failure) => (
                  <p key={failure.name} className="text-xs text-destructive">
                    {failure.name}: {failure.reason}
                  </p>
                ))}
                {error ? <p className="text-xs text-destructive">{error}</p> : null}
              </form>
            </DialogPanel>
            <DialogFooter variant="bare">
              <Button variant="outline" onClick={onClose}>
                {imported ? "Done" : "Cancel"}
              </Button>
              <Button disabled={!importReady || pending} onClick={() => void runImport()}>
                {pending ? "Importing…" : "Import"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}
