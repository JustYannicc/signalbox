# Automations

An automation is work Signalbox does for you on a schedule, when a webhook arrives, when
something happens in your threads, or when you run it. It can hand tasks to agents, call web services, and stop to ask you before it does
something you want to approve.

## Create one

Ask an agent in any thread, for example "Every weekday at 9, summarize new Sentry issues and ask
me before filing any of them in Linear." The agent writes the automation and saves it. **New
automation** at the top of the Automations panel starts that thread for you.

To change an automation, choose **Change with agent** from its **⋯** menu or above its code (on
mobile, on the automation's screen or a run's **⋯** menu). It opens a thread with the request
started; say what to change and send it. **Add a step** on the diagram does the same for one new
step or trigger. **Automations → Steps** lists everything an automation can do.

To try a change before it goes live, ask the agent to save it as a draft. The automation keeps
running its live version and its page shows **Draft**: switch between **Live** and **Draft** to
compare the diagram and code, or read **Changes** for the lines that differ. **Publish** makes the
draft live; **Discard** drops it. A new automation saved as a draft stays off until you publish it.

Open **Automations** in the sidebar rail to see every automation on your connected environments.
Unfold one to see its recent runs. Sort and filter from the panel's header.

## Connect your services

Automations reach your accounts, like Gmail, GitHub or Linear, through
[Executor](https://executor.sh). Connect your accounts in Executor, then open **Settings →
Integrations → Connected services** (on mobile, **Settings → Connected services**), paste
Executor's URL and an API key, and choose **Connect**. Signalbox checks the key before saving it
and lists every account it found. With several accounts for one service, an automation picks one
by its name in Executor.

## Triggers

- **On a schedule**: the automation's page shows when it runs next.
- **When a webhook arrives**: copy the URL from the automation's **⋯** menu. Anyone with the URL
  can start a run, so treat it like a password.
- **When something happens**: a turn finishes, you send a message, a thread starts, an agent
  needs you, another automation fails, and more. It works the same whichever agent ran the thread.
  Ask for it in your own words ("when a turn fails, tell me why"). By default it only reacts to
  threads in the automation's project, and never to threads automations started themselves. If
  events start more than 30 runs in a minute, its event triggers pause and you're notified; save
  it, or switch it off and on, to resume.
- **Run now** starts a run by hand. An automation only a webhook or events start offers **Replay this run**
  instead, which runs again with the shown run's payload; **Run now without input** stays in its
  **⋯** menu.

Switch it to **Paused** to stop scheduled, webhook and event runs. **Run now** still works while it is
paused.

## Follow a run

Pick a run in the panel, or switch the automation's page to **Run**, to read it like a chat: how it
started, one message per step with how long it took and what it returned, loop passes grouped
together, and how it ended. Questions are answered right there. **Show on diagram** draws the same
run over the diagram. On mobile, a run opens as its chat; switch to **Diagram** at the top.

A failed or cancelled run can be retried with **Retry**. The new run reuses what the steps that
went well returned and runs the failed step and everything after it again, so nothing that already
happened happens twice. After fixing the automation, retry on the latest version to run the fix
from where the run stopped. Steps whose code moved or changed run again too.

## Read the diagram

The automation's page draws it top to bottom. A decision fans out into one path per option,
loops and parallel work sit in labelled boxes, and steps that use a service show its logo.

The latest run is drawn over the diagram: paths it took are solid, the rest are faded, and loops
show how many passes ran. Pick an older run from the run menu in the top left. Select any step
to see what it did in that run: its result, its error, and for agent steps, the agent's thread.

Switch to **Code** to read the TypeScript the diagram is drawn from. **Show in code** on a step
jumps to its line.

## Answer questions

When an automation needs a decision, it waits and notifies you. Answer from either place:

- **Needs you** at the top of the Automations panel. The same list also sits on top of
  **Pipeline**.
- The **Automations** page, which lists every question waiting on you and every automation whose
  last run failed.
- The waiting step in the run, or on the diagram.

Notifications follow your settings in **Settings → General**. When your phone gets Signalbox
notifications, a question also reaches it, and so does a message an automation sends with
`w.notify`. Tap one to open the run. A `w.notify` with `{ importance: "low" }` stays in the app.
