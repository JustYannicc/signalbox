import {
  blockContract,
  undeclaredContractLabel,
  UNREADABLE_CONTRACT,
} from "@t3tools/client-runtime/automations/blockContract";
import {
  BLOCK_LIBRARY_EMPTY,
  blockLibraryStatuses,
  blockPermissionsLabel,
  groupBlockLibrary,
  type BlockLibraryTarget,
} from "@t3tools/client-runtime/automations/blockLibrary";
import type { AutomationBlockLibraryEntry } from "@t3tools/contracts";
import type * as Schema from "effect/Schema";
import { ChevronRightIcon } from "lucide-react";

import { automationState } from "~/state/automations";
import { useEnvironmentQuery } from "~/state/query";
import { runtimeModeConfig } from "../chat/runtimeModeConfig";
import { CodeBlock } from "../automations/CodeBlock";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Spinner } from "../ui/spinner";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** What one folder's automations can start by name, grouped by where each block lives. */
export function BlockLibraryList({ target }: { readonly target: BlockLibraryTarget }) {
  const query = useEnvironmentQuery(
    automationState.blocks({
      environmentId: target.environmentId,
      input: { projectId: target.projectId },
    }),
  );
  if (query.data === null) {
    return (
      <SettingsSection id="block-library-blocks" title="Blocks">
        <SettingsRow
          title={
            <span className="inline-flex items-center gap-2">
              {query.error === null ? <Spinner size="sm" tone="muted" /> : null}
              {query.error === null ? "Loading blocks" : "Could not load blocks"}
            </span>
          }
          status={
            query.error === null ? undefined : (
              <span role="alert" className="text-destructive">
                {query.error}
              </span>
            )
          }
          control={
            query.error === null ? undefined : (
              <Button size="xs" variant="outline" onClick={query.refresh}>
                Try again
              </Button>
            )
          }
        />
      </SettingsSection>
    );
  }

  const groups = groupBlockLibrary(target, query.data.blocks);
  if (groups.length === 0) {
    return (
      <SettingsSection id="block-library-blocks" title="Blocks">
        <SettingsRow title="Blocks" description={BLOCK_LIBRARY_EMPTY} />
      </SettingsSection>
    );
  }

  return groups.map((group) => (
    <SettingsSection key={group.key} title={group.title}>
      {group.blocks.map((block) => (
        <BlockRow key={block.name} block={block} />
      ))}
    </SettingsSection>
  ));
}

function BlockRow({ block }: { readonly block: AutomationBlockLibraryEntry }) {
  const runtimeMode = block.availability.runtimeMode;
  return (
    <SettingsRow
      title={
        <span className="inline-flex flex-wrap items-center gap-1.5">
          {block.name}
          {blockLibraryStatuses(block.availability).map((status) => (
            <Badge key={status} size="sm" variant="warning">
              {status}
            </Badge>
          ))}
        </span>
      }
      description={block.description ?? undefined}
      status={blockPermissionsLabel(
        runtimeMode === null ? null : runtimeModeConfig[runtimeMode].label,
      )}
    >
      <div className="flex flex-col gap-1 pb-2">
        <ContractRow side="input" contract={block.input} />
        <ContractRow side="output" contract={block.output} />
      </div>
    </SettingsRow>
  );
}

function ContractRow(props: {
  readonly side: "input" | "output";
  readonly contract: Schema.Json | undefined;
}) {
  if (props.contract === undefined) {
    return <p className="text-xs text-muted-foreground">{undeclaredContractLabel(props.side)}</p>;
  }
  return (
    <Collapsible>
      <CollapsibleTrigger className="group inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <ChevronRightIcon className="size-3 transition-transform group-data-panel-open:rotate-90" />
        {props.side === "input" ? "Input" : "Output"}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <ContractCode contract={props.contract} />
      </CollapsiblePanel>
    </Collapsible>
  );
}

/** Rendered only once opened: writing the schema back out isn't free. */
function ContractCode({ contract }: { readonly contract: Schema.Json }) {
  const view = blockContract(contract);
  return (
    <div className="pt-1 select-text">
      {view._tag === "Declared" ? (
        <CodeBlock>{view.code}</CodeBlock>
      ) : (
        <p className="text-xs text-muted-foreground">{UNREADABLE_CONTRACT}</p>
      )}
    </div>
  );
}
