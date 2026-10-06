import type { EnvironmentId } from "@t3tools/contracts";
import { type PoolApiKeyProvider, PERSONAL_POOL_ID } from "@t3tools/contracts/accountHub";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { failureText } from "../accountPool/PoolDialogs";
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
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";

const PROVIDERS: ReadonlyArray<{
  readonly value: PoolApiKeyProvider;
  readonly label: string;
  readonly placeholder: string;
}> = [
  { value: "anthropic", label: "Anthropic", placeholder: "sk-ant-api03-…" },
  { value: "openai", label: "OpenAI", placeholder: "sk-…" },
  { value: "xai", label: "xAI", placeholder: "xai-…" },
  { value: "gemini", label: "Gemini", placeholder: "AIza…" },
  { value: "openrouter", label: "OpenRouter", placeholder: "sk-or-…" },
  { value: "cursor", label: "Cursor", placeholder: "key_…" },
  { value: "openai-compatible", label: "Other OpenAI-compatible API", placeholder: "API key" },
];

/**
 * Adds an API key to a pool. It joins the pool's accounts of the same
 * provider: an Anthropic key takes Claude turns beside Claude logins.
 */
export function AddPoolApiKeyDialog({
  environmentId,
  poolId = PERSONAL_POOL_ID,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly poolId?: string;
  readonly onClose: () => void;
}) {
  const add = useAtomCommand(serverEnvironment.addAccountPoolApiKey, { reportFailure: false });
  const [provider, setProvider] = useState<PoolApiKeyProvider>("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = PROVIDERS.find((candidate) => candidate.value === provider)!;
  const needsUrl = provider === "openai-compatible";
  const ready = apiKey.trim() !== "" && (!needsUrl || baseUrl.trim() !== "");

  const save = async () => {
    setPending(true);
    setError(null);
    const result = await add({
      environmentId,
      input: {
        poolId,
        provider,
        apiKey: apiKey.trim(),
        ...(needsUrl ? { baseUrl: baseUrl.trim() } : {}),
      },
    });
    setPending(false);
    if (result._tag !== "Success") {
      setError(failureText(result, "Could not add the API key."));
      return;
    }
    toastManager.add({ type: "success", title: `${selected.label} API key added` });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add API key</DialogTitle>
          <DialogDescription>
            The key joins this pool beside its accounts, and Signalbox spreads work across them. It
            stays on the server.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (ready && !pending) void save();
            }}
          >
            <div className="grid gap-1.5">
              <Label>Provider</Label>
              <Select
                value={provider}
                onValueChange={(value) => {
                  const next = PROVIDERS.find((candidate) => candidate.value === value);
                  if (next) setProvider(next.value);
                }}
              >
                <SelectTrigger aria-label="Provider">
                  <SelectValue>
                    {(value: string | null) =>
                      PROVIDERS.find((candidate) => candidate.value === value)?.label ?? "Provider"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {PROVIDERS.map((candidate) => (
                    <SelectItem key={candidate.value} value={candidate.value}>
                      {candidate.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            {needsUrl ? (
              <div className="grid gap-1.5">
                <Label htmlFor="pool-api-key-url">Endpoint URL</Label>
                <Input
                  id="pool-api-key-url"
                  placeholder="https://api.example.com/v1"
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                />
              </div>
            ) : null}
            <div className="grid gap-1.5">
              <Label htmlFor="pool-api-key">API key</Label>
              <Input
                id="pool-api-key"
                type="password"
                autoComplete="off"
                autoFocus
                placeholder={selected.placeholder}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </div>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!ready || pending} onClick={() => void save()}>
            Add
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
