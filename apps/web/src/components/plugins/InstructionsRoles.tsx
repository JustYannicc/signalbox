/**
 * The role axis of Instructions: a picker laid out as the delegation chain
 * (assistant → section → project → workflow → thread), and the assistant's
 * read-only SOUL.md.
 */
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { Fragment } from "react";

import { AssistantIcon, useAssistantIdentity } from "../assistant/assistantIdentity";
import { useAssistantSoulState } from "../assistant/assistantSoul";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { INSTRUCTION_ROLES, ROLE_INFO, roleLabel, type InstructionRole } from "./instructionsModel";

const SOUL_PREVIEW_LINES = 6;

export function RolePicker(props: {
  role: InstructionRole;
  onChange: (role: InstructionRole) => void;
}) {
  const { name } = useAssistantIdentity();
  const info = ROLE_INFO[props.role];
  return (
    <div className="flex flex-col gap-1.5">
      <ToggleGroup
        aria-label="Agent role"
        variant="default"
        value={[props.role]}
        onValueChange={(next) => {
          const value = INSTRUCTION_ROLES.find((role) => role === next[0]);
          if (value) props.onChange(value);
        }}
        className="flex-wrap items-center"
      >
        {INSTRUCTION_ROLES.map((role, index) => (
          <Fragment key={role}>
            {index > 0 ? (
              <ChevronRightIcon aria-hidden className="size-3.5 text-muted-foreground" />
            ) : null}
            <Toggle value={role} size="sm">
              {role === "assistant" ? <AssistantIcon size={16} /> : null}
              {roleLabel(role, name)}
            </Toggle>
          </Fragment>
        ))}
      </ToggleGroup>
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant={info.supervisor ? "info" : "secondary"} size="sm">
          {info.supervisor ? "Supervisor · personal" : "Worker"}
        </Badge>
        {info.position}
      </p>
    </div>
  );
}

export function SoulCard() {
  const { name } = useAssistantIdentity();
  const [soul] = useAssistantSoulState();
  const excerpt = soul.split("\n").slice(0, SOUL_PREVIEW_LINES).join("\n");
  return (
    <section className="flex flex-col gap-2 rounded-xl border border-border/60 bg-card/40 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <AssistantIcon size={20} />
        <h3 className="text-sm font-medium text-foreground">{name}'s SOUL.md</h3>
        <Button
          size="xs"
          variant="outline"
          className="ms-auto"
          render={<Link to="/assistant" search={{ customize: "soul" }} />}
        >
          Edit in {name} › Customize
        </Button>
      </div>
      <pre className="rounded-lg bg-muted/40 p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-foreground">
        {excerpt}
      </pre>
    </section>
  );
}
