import type { EnvironmentId } from "@t3tools/contracts";
import type { Section } from "@t3tools/contracts/sections";
import type { Dispatch, SetStateAction } from "react";

import { Button } from "../../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Input } from "../../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import type { SectionEnvironmentOption } from "./SectionSidebarActions";

export type SectionEditor =
  | {
      readonly kind: "create";
      readonly environmentId: EnvironmentId | null;
      readonly parentId: string | null;
      readonly name: string;
      /** signalbox: the cloud context a top-level section organizes. */
      readonly contextId?: string;
    }
  | {
      readonly kind: "rename";
      readonly environmentId: EnvironmentId;
      readonly sectionId: string;
      readonly name: string;
    };

export interface SectionDeletePrompt {
  readonly environmentId: EnvironmentId;
  readonly section: Section;
  readonly parentName: string | null;
}

export function SectionSidebarDialogs(props: {
  environments: ReadonlyArray<SectionEnvironmentOption>;
  editor: SectionEditor | null;
  setEditor: Dispatch<SetStateAction<SectionEditor | null>>;
  deletePrompt: SectionDeletePrompt | null;
  editorPending: boolean;
  deletePending: boolean;
  environmentLabel: (environmentId: EnvironmentId | null) => string;
  closeEditor: () => void;
  closeDelete: () => void;
  commitEditor: () => void;
  commitDelete: () => void;
}) {
  return (
    <>
      <Dialog open={props.editor !== null} onOpenChange={(open) => !open && props.closeEditor()}>
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {props.editor?.kind === "rename" ? "Rename section" : "New section"}
            </DialogTitle>
            <DialogDescription>
              {props.editor?.kind === "rename"
                ? "Choose a name for this section."
                : props.editor?.parentId
                  ? `Create a subsection in ${props.environmentLabel(props.editor.environmentId)}.`
                  : "Sections keep related projects together."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <form
              className="grid gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                props.commitEditor();
              }}
            >
              {props.editor?.kind === "create" &&
              props.editor.parentId === null &&
              props.environments.length > 1 ? (
                <div className="grid gap-1.5">
                  <span className="text-xs font-medium text-foreground">Environment</span>
                  <Select
                    disabled={props.editorPending}
                    value={props.editor.environmentId ?? ""}
                    onValueChange={(value) =>
                      props.setEditor((current) =>
                        current?.kind === "create"
                          ? { ...current, environmentId: (value as EnvironmentId) || null }
                          : current,
                      )
                    }
                  >
                    <SelectTrigger className="w-full" aria-label="Environment for section">
                      <SelectValue placeholder="Choose an environment" />
                    </SelectTrigger>
                    <SelectPopup>
                      {props.environments.map((environment) => (
                        <SelectItem
                          key={environment.environmentId}
                          value={environment.environmentId}
                        >
                          {environment.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              ) : null}
              <div className="grid gap-1.5">
                <label className="text-xs font-medium text-foreground" htmlFor="section-name">
                  Name
                </label>
                <Input
                  id="section-name"
                  aria-label="Section name"
                  autoFocus
                  disabled={props.editorPending}
                  maxLength={128}
                  value={props.editor?.name ?? ""}
                  onChange={(event) =>
                    props.setEditor((current) =>
                      current ? { ...current, name: event.target.value } : current,
                    )
                  }
                  placeholder="Section name"
                />
              </div>
            </form>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" disabled={props.editorPending} onClick={props.closeEditor}>
              Cancel
            </Button>
            <Button
              disabled={
                props.editorPending ||
                props.editor === null ||
                props.editor.name.trim().length === 0 ||
                props.editor.environmentId === null
              }
              onClick={props.commitEditor}
            >
              {props.editor?.kind === "rename" ? "Save" : "Create section"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={props.deletePrompt !== null}
        onOpenChange={(open) => !open && props.closeDelete()}
      >
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Delete section?</DialogTitle>
            <DialogDescription>
              {props.deletePrompt
                ? `Deleting “${props.deletePrompt.section.name}” moves its projects and nested sections up to ${props.deletePrompt.parentName ?? "the top level"}.`
                : "Projects and nested sections move up to the parent."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={props.deletePending} onClick={props.closeDelete}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={props.deletePending}
              onClick={props.commitDelete}
            >
              {props.deletePending ? "Deleting…" : "Delete section"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
