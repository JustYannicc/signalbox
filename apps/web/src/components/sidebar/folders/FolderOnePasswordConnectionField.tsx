import { formatRelativeTimeLabel } from "../../../timestampFormat";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";

type TokenMode = "connected" | "replace" | "disconnect";

export function FolderOnePasswordConnectionField(props: {
  readonly formId: string;
  readonly connectedAt: number | null;
  readonly askToken: boolean;
  readonly tokenMode: TokenMode;
  readonly token: string;
  readonly pending: boolean;
  readonly disconnecting: boolean;
  readonly onTokenChange: (value: string) => void;
  readonly onKeepCurrentToken: () => void;
  readonly onReplaceToken: () => void;
  readonly onStartDisconnect: () => void;
  readonly onConfirmDisconnect: () => void;
  readonly onCancelDisconnect: () => void;
}) {
  if (props.askToken) {
    return (
      <div className="grid gap-1.5">
        <Label htmlFor={`${props.formId}-token`}>Service account token</Label>
        <Input
          id={`${props.formId}-token`}
          autoComplete="off"
          autoFocus={props.tokenMode === "replace"}
          disabled={props.pending}
          placeholder="ops_…"
          spellCheck={false}
          type="password"
          value={props.token}
          onChange={(event) => props.onTokenChange(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          1Password shows it once, when you create a service account with read access to this
          Environment. One token covers all your folders.
        </p>
        {props.connectedAt === null ? null : (
          <div>
            <Button
              size="xs"
              variant="ghost"
              disabled={props.pending}
              onClick={props.onKeepCurrentToken}
            >
              Keep current token
            </Button>
          </div>
        )}
      </div>
    );
  }

  if (props.tokenMode === "disconnect") {
    return (
      <div className="grid gap-2 rounded-lg border px-3 py-2.5">
        <p className="text-sm">
          Disconnect 1Password? Secrets stop loading in all your folders until you connect it again.
        </p>
        <div className="flex justify-end gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={props.pending}
            onClick={props.onCancelDisconnect}
          >
            Cancel
          </Button>
          <Button
            size="xs"
            variant="destructive"
            disabled={props.pending}
            onClick={props.onConfirmDisconnect}
          >
            {props.disconnecting ? "Disconnecting…" : "Disconnect"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-lg border px-3 py-2">
      <p className="min-w-0 flex-1 text-sm">
        1Password connected
        {props.connectedAt === null ? null : (
          <span className="text-muted-foreground">
            {" "}
            · {formatRelativeTimeLabel(new Date(props.connectedAt).toISOString())}
          </span>
        )}
      </p>
      <Button size="xs" variant="outline" disabled={props.pending} onClick={props.onReplaceToken}>
        Replace token
      </Button>
      <Button
        size="xs"
        variant="ghost-destructive"
        disabled={props.pending}
        onClick={props.onStartDisconnect}
      >
        Disconnect
      </Button>
    </div>
  );
}
