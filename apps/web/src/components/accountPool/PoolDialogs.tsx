import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import type { AccountHubImportResult, AccountPool } from "@t3tools/contracts/accountHub";
import { useState } from "react";

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

export const failureText = (
  result: Parameters<typeof squashAtomCommandFailure>[0],
  fallback: string,
) => {
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

/** Names a new pool, or renames one. */
export function PoolNameDialog({
  environmentId,
  pool,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  /** Absent to create a pool. */
  readonly pool?: AccountPool;
  readonly onClose: () => void;
}) {
  const create = useAtomCommand(serverEnvironment.createAccountPool, { reportFailure: false });
  const rename = useAtomCommand(serverEnvironment.renameAccountPool, { reportFailure: false });
  const [name, setName] = useState(pool?.name ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setPending(true);
    setError(null);
    const result = pool
      ? await rename({ environmentId, input: { poolId: pool.id, name: name.trim() } })
      : await create({ environmentId, input: { name: name.trim() } });
    setPending(false);
    if (result._tag !== "Success") {
      setError(failureText(result, "Could not save the pool."));
      return;
    }
    onClose();
  };
  const ready = name.trim() !== "" && name.trim() !== pool?.name;
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{pool ? "Rename pool" : "New pool"}</DialogTitle>
          <DialogDescription>
            A pool is a set of accounts work spreads across, like your own or your team's.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              if (ready && !pending) void save();
            }}
          >
            <Label htmlFor="pool-name">Name</Label>
            <Input
              id="pool-name"
              autoFocus
              placeholder="Work"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!ready || pending} onClick={() => void save()}>
            {pool ? "Rename" : "Create"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * Where a pool keeps its logins: with Signalbox, or in a CLIProxyAPI the user
 * already runs. Keys are sent once and kept on the server.
 */
export function PoolBackingDialog({
  environmentId,
  pool,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly pool: AccountPool;
  readonly onClose: () => void;
}) {
  const setBacking = useAtomCommand(serverEnvironment.setAccountPoolBacking, {
    reportFailure: false,
  });
  const [mode, setMode] = useState(pool.backing.mode);
  const [url, setUrl] = useState(pool.backing.mode === "external" ? pool.backing.url : "");
  const [managementKey, setManagementKey] = useState("");
  const [clientKey, setClientKey] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setPending(true);
    setError(null);
    const result = await setBacking({
      environmentId,
      input: {
        poolId: pool.id,
        backing:
          mode === "managed"
            ? { mode: "managed" }
            : {
                mode: "external",
                url: url.trim(),
                managementKey: managementKey.trim(),
                clientKey: clientKey.trim(),
              },
      },
    });
    setPending(false);
    if (result._tag !== "Success") {
      setError(failureText(result, "Could not connect to that CLIProxyAPI."));
      return;
    }
    toastManager.add({ type: "success", title: `${pool.name} updated` });
    onClose();
  };

  const ready =
    mode === "managed"
      ? pool.backing.mode !== "managed"
      : url.trim() !== "" && managementKey.trim() !== "" && clientKey.trim() !== "";

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Where {pool.name} keeps its logins</DialogTitle>
          <DialogDescription>
            Signalbox keeps them for you, or point the pool at a CLIProxyAPI you already run.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (ready && !pending) void save();
            }}
          >
            <RadioGroup
              value={mode}
              onValueChange={(value) => setMode(value === "external" ? "external" : "managed")}
            >
              <label className="flex items-center gap-2 text-sm">
                <Radio value="managed" />
                Signalbox keeps them
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Radio value="external" />
                My CLIProxyAPI
              </label>
            </RadioGroup>
            {mode === "external" ? (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor="pool-url">URL</Label>
                  <Input
                    id="pool-url"
                    placeholder="https://cliproxyapi.example.com"
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="pool-management-key">Management key</Label>
                  <Input
                    id="pool-management-key"
                    type="password"
                    autoComplete="off"
                    value={managementKey}
                    onChange={(event) => setManagementKey(event.target.value)}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="pool-client-key">API key</Label>
                  <Input
                    id="pool-client-key"
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
          <Button disabled={!ready || pending} onClick={() => void save()}>
            {pending ? "Checking…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** Moves (or copies) the accounts of a CLIProxyAPI the user runs into a pool. */
export function PoolImportDialog({
  environmentId,
  pool,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly pool: AccountPool;
  readonly onClose: () => void;
}) {
  const importAccounts = useAtomCommand(serverEnvironment.importAccountPoolAccounts, {
    reportFailure: false,
  });
  const [url, setUrl] = useState("");
  const [managementKey, setManagementKey] = useState("");
  const [removeFromSource, setRemoveFromSource] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imported, setImported] = useState<AccountHubImportResult | null>(null);

  const run = async () => {
    setPending(true);
    setError(null);
    setImported(null);
    const result = await importAccounts({
      environmentId,
      input: {
        poolId: pool.id,
        url: url.trim(),
        managementKey: managementKey.trim(),
        removeFromSource,
      },
    });
    setPending(false);
    if (result._tag !== "Success") {
      setError(failureText(result, "Could not import from that CLIProxyAPI."));
      return;
    }
    setImported(result.value);
  };
  const ready = url.trim() !== "" && managementKey.trim() !== "";

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Import into {pool.name}</DialogTitle>
          <DialogDescription>
            Bring the accounts of a CLIProxyAPI you already run into this pool.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (ready && !pending) void run();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="import-url">URL</Label>
              <Input
                id="import-url"
                placeholder="https://cliproxyapi.example.com"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="import-key">Management key</Label>
              <Input
                id="import-key"
                type="password"
                autoComplete="off"
                value={managementKey}
                onChange={(event) => setManagementKey(event.target.value)}
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
                  Two places refreshing the same account sign each other out.
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
          <Button disabled={!ready || pending} onClick={() => void run()}>
            {pending ? "Importing…" : "Import"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
