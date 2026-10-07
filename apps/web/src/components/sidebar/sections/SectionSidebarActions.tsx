import { useAtomSet } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import type { AccountPoolId } from "@t3tools/contracts/accountHub";
import type {
  Section,
  SectionCreateInput,
  SectionDeleteInput,
  SectionMoveInput,
  SectionId,
  SectionProjectMoveInput,
  SectionUpdateInput,
} from "@t3tools/contracts/sections";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { useAtomCommand } from "../../../state/use-atom-command";
import { environmentSections } from "../../../state/sections";

import { stackedThreadToast, toastManager } from "../../ui/toast";
import {
  SectionSidebarDialogs,
  type SectionDeletePrompt,
  type SectionEditor,
} from "./SectionSidebarDialogs";

export interface SectionEnvironmentOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export interface SectionSidebarActions {
  readonly environments: ReadonlyArray<SectionEnvironmentOption>;
  openCreate: (environmentId?: EnvironmentId, parentId?: string | null, contextId?: string) => void;
  openRename: (environmentId: EnvironmentId, section: Section) => void;
  openDelete: (environmentId: EnvironmentId, section: Section, parentName: string | null) => void;
  createSection: (environmentId: EnvironmentId, input: SectionCreateInput) => Promise<boolean>;
  updateSection: (environmentId: EnvironmentId, input: SectionUpdateInput) => Promise<boolean>;
  /** The pool new threads in the section's projects start on; null inherits it again. */
  setSectionPool: (
    environmentId: EnvironmentId,
    sectionId: SectionId,
    defaultPoolId: AccountPoolId | null,
  ) => Promise<boolean>;
  moveSection: (environmentId: EnvironmentId, input: SectionMoveInput) => Promise<boolean>;
  deleteSection: (environmentId: EnvironmentId, input: SectionDeleteInput) => Promise<boolean>;
  moveProject: (environmentId: EnvironmentId, input: SectionProjectMoveInput) => Promise<boolean>;
  retrySections: (environmentId: EnvironmentId) => void;
}

const SectionSidebarActionsContext = createContext<SectionSidebarActions | null>(null);

function useSectionCommands() {
  const create = useAtomCommand(environmentSections.createSection, { reportFailure: false });
  const update = useAtomCommand(environmentSections.updateSection, { reportFailure: false });
  const move = useAtomCommand(environmentSections.moveSection, { reportFailure: false });
  const remove = useAtomCommand(environmentSections.deleteSection, { reportFailure: false });
  const moveProject = useAtomCommand(environmentSections.moveProject, { reportFailure: false });

  return useMemo(() => {
    const run = async <A, E>(label: string, command: Promise<AtomCommandResult<A, E>>) => {
      const result = await command;
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: label,
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
        return false;
      }
      return result._tag === "Success";
    };

    return {
      create: (environmentId: EnvironmentId, input: SectionCreateInput) =>
        run("Could not create section", create({ environmentId, input })),
      update: (environmentId: EnvironmentId, input: SectionUpdateInput) =>
        run("Could not rename section", update({ environmentId, input })),
      setPool: (environmentId: EnvironmentId, id: SectionId, defaultPoolId: AccountPoolId | null) =>
        run(
          "Could not change the section's pool",
          update({ environmentId, input: { id, defaultPoolId } }),
        ),
      move: (environmentId: EnvironmentId, input: SectionMoveInput) =>
        run("Could not move section", move({ environmentId, input })),
      remove: (environmentId: EnvironmentId, input: SectionDeleteInput) =>
        run("Could not delete section", remove({ environmentId, input })),
      moveProject: (environmentId: EnvironmentId, input: SectionProjectMoveInput) =>
        run("Could not move project", moveProject({ environmentId, input })),
    };
  }, [create, move, moveProject, remove, update]);
}

export function SectionSidebarActionsProvider(props: {
  environments: ReadonlyArray<SectionEnvironmentOption>;
  children: ReactNode;
}) {
  const commands = useSectionCommands();
  const retrySections = useAtomSet(environmentSections.retry);
  const [editor, setEditor] = useState<SectionEditor | null>(null);
  const [deletePrompt, setDeletePrompt] = useState<SectionDeletePrompt | null>(null);
  const editorPendingRef = useRef(false);
  const deletePendingRef = useRef(false);
  const [editorPending, setEditorPending] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const environmentLabel = useCallback(
    (environmentId: EnvironmentId | null) =>
      props.environments.find((environment) => environment.environmentId === environmentId)
        ?.label ?? "environment",
    [props.environments],
  );
  const openCreate = useCallback(
    (environmentId?: EnvironmentId, parentId: string | null = null, contextId?: string) => {
      if (editorPendingRef.current || deletePendingRef.current) return;
      setEditor({
        kind: "create",
        environmentId:
          environmentId ??
          (props.environments.length === 1 ? props.environments[0]!.environmentId : null),
        parentId,
        name: "",
        ...(contextId === undefined ? {} : { contextId }), // signalbox: contexts
      });
    },
    [props.environments],
  );
  const openRename = useCallback((environmentId: EnvironmentId, section: Section) => {
    if (editorPendingRef.current || deletePendingRef.current) return;
    setEditor({ kind: "rename", environmentId, sectionId: section.id, name: section.name });
  }, []);
  const openDelete = useCallback(
    (environmentId: EnvironmentId, section: Section, parentName: string | null) => {
      if (editorPendingRef.current || deletePendingRef.current) return;
      setDeletePrompt({ environmentId, section, parentName });
    },
    [],
  );
  const value = useMemo<SectionSidebarActions>(
    () => ({
      environments: props.environments,
      openCreate,
      openRename,
      openDelete,
      createSection: commands.create,
      updateSection: commands.update,
      setSectionPool: commands.setPool,
      moveSection: commands.move,
      deleteSection: commands.remove,
      moveProject: commands.moveProject,
      retrySections,
    }),
    [commands, openCreate, openDelete, openRename, props.environments, retrySections],
  );

  const commitEditor = async () => {
    if (editor === null || editorPendingRef.current) return;
    const name = editor.name.trim();
    if (name.length === 0) return;
    const environmentId = editor.environmentId;
    if (environmentId === null) return;

    editorPendingRef.current = true;
    setEditorPending(true);
    try {
      const saved =
        editor.kind === "create"
          ? await commands.create(environmentId, {
              name,
              parentId: editor.parentId,
              ...(editor.contextId === undefined ? {} : { contextId: editor.contextId }), // signalbox: contexts
            })
          : await commands.update(environmentId, { id: editor.sectionId, name });
      if (saved) setEditor((current) => (current === editor ? null : current));
    } finally {
      editorPendingRef.current = false;
      setEditorPending(false);
    }
  };
  const commitDelete = async () => {
    if (deletePrompt === null || deletePendingRef.current) return;
    deletePendingRef.current = true;
    setDeletePending(true);
    try {
      if (await commands.remove(deletePrompt.environmentId, { id: deletePrompt.section.id })) {
        setDeletePrompt((current) => (current === deletePrompt ? null : current));
      }
    } finally {
      deletePendingRef.current = false;
      setDeletePending(false);
    }
  };
  const closeEditor = useCallback(() => {
    if (!editorPendingRef.current) setEditor(null);
  }, []);
  const closeDelete = useCallback(() => {
    if (!deletePendingRef.current) setDeletePrompt(null);
  }, []);

  return (
    <SectionSidebarActionsContext value={value}>
      {props.children}
      <SectionSidebarDialogs
        environments={props.environments}
        editor={editor}
        setEditor={setEditor}
        deletePrompt={deletePrompt}
        editorPending={editorPending}
        deletePending={deletePending}
        environmentLabel={environmentLabel}
        closeEditor={closeEditor}
        closeDelete={closeDelete}
        commitEditor={() => void commitEditor()}
        commitDelete={() => void commitDelete()}
      />
    </SectionSidebarActionsContext>
  );
}

export function useSectionSidebarActions(): SectionSidebarActions {
  const actions = useContext(SectionSidebarActionsContext);
  if (actions === null)
    throw new Error("Section sidebar actions must be used inside its provider.");
  return actions;
}
