import { setSubfolderSecretIncluded } from "@t3tools/client-runtime/state/folderSecrets";
import type { Dispatch, SetStateAction } from "react";

import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { Switch } from "../../ui/switch";

export function FolderSecretSubfoldersField(props: {
  readonly formId: string;
  readonly topLevel: boolean;
  readonly named: boolean;
  readonly pending: boolean;
  readonly keyName: string;
  readonly keyNames: ReadonlyArray<string>;
  readonly includedNames: ReadonlyArray<string>;
  readonly keyNameError: string | null;
  readonly setIncludedNames: Dispatch<SetStateAction<ReadonlyArray<string>>>;
  readonly onKeyNameChange: (value: string) => void;
  readonly onAddKeyName: () => void;
}) {
  const {
    formId,
    named,
    pending,
    keyName,
    keyNames,
    includedNames,
    keyNameError,
    setIncludedNames,
    onKeyNameChange,
    onAddKeyName,
  } = props;

  return (
    <section className="grid gap-2.5" aria-labelledby={`${formId}-subfolders-heading`}>
      <div className="grid gap-1">
        <h3 id={`${formId}-subfolders-heading`} className="text-sm font-medium">
          Include in subfolders
        </h3>
        <p className="text-xs text-muted-foreground">
          {props.topLevel
            ? "By default, this Environment's variables go only to threads in the top level."
            : "By default, this Environment's variables go only to threads in this folder."}{" "}
          To share one with child folders, enter its exact variable name and turn on Include
          subfolders. Changes apply on the next turn. Only enabled names are saved. Add a name again
          to opt it in later.
        </p>
      </div>
      <div className="flex items-end gap-2">
        <div className="min-w-0 flex-1 grid gap-1.5">
          <Label htmlFor={`${formId}-key-name`}>Environment variable name</Label>
          <Input
            id={`${formId}-key-name`}
            autoComplete="off"
            autoCapitalize="none"
            disabled={pending || !named}
            placeholder="API_KEY"
            spellCheck={false}
            value={keyName}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onAddKeyName();
              }
            }}
            onChange={(event) => onKeyNameChange(event.target.value)}
          />
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending || !named}
          onClick={onAddKeyName}
        >
          Add name
        </Button>
      </div>
      {keyNameError === null ? null : (
        <p role="alert" className="text-xs text-destructive">
          {keyNameError}
        </p>
      )}
      {keyNames.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No names listed. Add a name to choose whether it reaches subfolders.
        </p>
      ) : (
        <ul className="grid gap-1">
          {keyNames.map((name) => (
            <li key={name} className="flex min-w-0 items-center gap-3 rounded-md border px-3 py-2">
              <code className="min-w-0 flex-1 truncate text-sm">{name}</code>
              <span className="shrink-0 text-xs text-muted-foreground">Include subfolders</span>
              <Switch
                size="sm"
                aria-label={`Include ${name} in subfolders`}
                checked={includedNames.includes(name)}
                disabled={pending}
                onCheckedChange={(checked) =>
                  setIncludedNames((currentNames) =>
                    setSubfolderSecretIncluded(currentNames, name, checked),
                  )
                }
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
