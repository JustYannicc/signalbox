# Automations

An automation is work Signalbox does for you on a schedule, when a webhook arrives, when
something happens in your threads, or when you run it. It can hand tasks to agents, call web services, and stop to ask you before it does
something you want to approve.

## Create one

Ask an agent in any thread, for example "Every weekday at 9, summarize new Sentry issues and ask
me before filing any of them in Linear." The agent writes the automation and saves it in the thread's
folder. **New automation** in a folder's **⋯** menu starts that thread for you.

To change an automation, choose **Change with agent** from its **⋯** menu or above its code (on
mobile, on the automation's screen or a run's **⋯** menu). It opens a thread with the request
started; say what to change and send it. **Add a step** on the diagram does the same for one new
step or trigger. **Automation triggers and steps** in the command palette lists everything an
automation can do.

To try a change before it goes live, ask the agent to save it as a draft. The automation keeps
running its live version and its page shows **Draft**: switch between **Live** and **Draft** to
compare the diagram and code, or read **Changes** for the lines that differ. **Publish** makes the
draft live; **Discard** drops it. A new automation saved as a draft stays off until you publish it.

## Find one

An automation lives in its folder in Home, next to that folder's threads. A folder's automations
fold into one row; open it to see them all. One that needs you, with a question waiting or a run
that failed, shows on its own, and questions also wait at the top of Home, where you can answer
them without opening anything. Opening an automation shows its runs beside the diagram, the ones
that need you on top. To jump to any automation, choose **Open automation…** in the command
palette (`mod+alt+w`).

## In Signalbox Cloud

Automations in your cloud folders run in Signalbox Cloud, so they fire on schedules, thread events, file changes
and pull request news with every app closed, and their questions reach your phone. Ask an agent in
a cloud thread to write one. When an agent there schedules recurring work for itself ("every 5
minutes, post the time"), that's an automation in the thread's folder too: pause or delete it like
any other, or ask the agent to stop it. Webhooks and callback links work with every app closed.
Model steps use the model saved with the automation and the folder's pool. They interpret only the
text supplied to the step, without tools or access to your files. Use an agent step for work that needs them.

For GitHub events, connect GitHub in Settings and ask the agent to add a repository trigger.
Signalbox installs the webhook when your account has permission to manage that repository's hooks.
Published releases on upstream repositories can be checked every five minutes when hook access is unavailable.
An agent can check the connection status and explain missing permissions. Pull requests already linked to
threads keep their existing watcher.

Calls to connected services and local `w.run` functions still need a self-hosted server.
Steps on GitHub Actions are available as described below.

### Steps on GitHub Actions

In a folder added from GitHub, a step can run on the repository's GitHub Actions runners, with its
CI machines, secrets and environments. Ask the agent to run the step "on GitHub Actions". The
first time, the agent opens a pull request that adds Signalbox's step workflow
(`.github/workflows/signalbox-step.yml`); merge it.

These steps run as your GitHub account, so you lend it to the folder first: in the folder's ⋯
menu, turn on **Lend my GitHub to CI steps**. The switch then names the account the folder's CI
steps run as. Turn it off to stop; steps started after that fail and say how to lend it again,
while runs already going finish. If you connect a different GitHub account, lend it again. When
folders get their own GitHub App, steps will run as the App instead.

While a step runs, it shows the GitHub run's jobs and steps live, whose GitHub it runs as, the end
of each job's log and a link to the run on GitHub. Its result goes on to the next step. Cancelling
the automation run cancels the GitHub run.

## Connect your services

Automations reach your accounts, like Gmail, GitHub or Linear, through
[Executor](https://executor.sh). Connect your accounts in Executor, then open **Settings →
Integrations → Connected services** (on mobile, **Settings → Connected services**), paste
Executor's URL and an API key, and choose **Connect**. Signalbox checks the key before saving it
and lists every account it found. With several accounts for one service, an automation picks one
by its name in Executor.

## Triggers

- **On a schedule**: the automation's page shows when it runs next.
- **When a webhook arrives**: copy the URL from the automation's **⋯** menu (on mobile, from its
  page). Anyone with the URL can start a run, so treat it like a password; **New webhook URL**
  replaces it. With [Signalbox Connect](remote-access.md) the URL is public and, with **Hold
  webhooks while offline**, requests wait while your server is down, as for
  [webhook tasks](project-settings.md#webhook-automations). To accept only requests signed by the
  sender, such as GitHub, ask the agent to require a signature: it asks you for the secret in a
  private card and never sees it. The automation's agent can tell you which requests were turned
  away and why.
- **When something happens**: a turn finishes, you send a message, a thread starts, an agent
  needs you, another automation fails, and more. It works the same whichever agent ran the thread.
  Ask for it in your own words ("when a turn fails, tell me why"). By default it only reacts to
  threads in the automation's project, and never to threads automations started themselves. If
  events start more than 30 runs in a minute, its event triggers pause and you're notified; save
  it, or switch it off and on, to resume.
- **When files in a cloud folder change**: work lands in the folder, or a thread saves its work
  before landing it, for a check before anything merges. Ask for it in your own words ("when a new
  file lands in this folder, summarize it"). The run gets which files were added, changed or
  removed, and the commits that changed them.
- **When something changes in a connected service**: a new GitHub Actions run, an invoice paid, a
  row added to a sheet. Ask for it in your own words ("when a new issue is filed in Linear, triage
  it"). Signalbox checks the service every few minutes, once for every automation and agent watching
  the same thing, and reacts only to what's new after the automation starts. The automation's page
  shows what it watches and when it last checked. If the service keeps failing, Signalbox stops
  checking and tells you; save the automation again to retry.
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

## When an agent waits

Ask an agent to wait for something, like CI on its pull request, another thread finishing, an
invoice being paid in a connected service, or tomorrow morning, and it ends its turn instead of sitting there polling. The thread stays in
**Working**, and the agent wakes with one message when it happens. A pull request it watches
keeps waking it on failed checks, other people's comments and reviews, and conflicts until it
merges.

When the work is done, the agent asks to merge instead of merging, and the folder's **Merge gate**
decides. Until checks pass at the latest commit, review threads are resolved and nothing conflicts,
the agent is sent back with what's missing and you hear nothing. A ready change that's easy to undo
merges by itself, and its branch is deleted. You get a needs-you, "Merge acme/app#12?", only for a
change that's hard to undo (a database migration, sign-in or access control, deleting data) or one
the agent says needs a decision. It shows the commit, the checks, the review state and why it's
asking: **merge** merges that commit, **not yet** sends the agent your reason. If new commits land
after the gate read them, nothing merges and the agent asks again.

To have a folder ask you about every merge, or to add its own hard-to-undo paths, have an agent
customize the built-in **Merge gate** there as a draft, then publish it yourself.

**Thread details → Waiting on** lists what the thread waits for. Open a row to see the run behind
it, or stop it there. Settling, archiving or stopping the thread ends its waits too. Each wait is a
built-in automation ("Wait for", "Watch pull request"), so you can customize how it behaves in a
project like any other automation.

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

- **Automations waiting on you** at the top of **Home**.
- The **Automations** page, which lists every question waiting on you and every automation whose
  last run failed.
- The waiting step in the run, or on the diagram.

Notifications follow your settings in **Settings → General**. When your phone gets Signalbox
notifications, a question also reaches it, and so does a message an automation sends with
`w.notify`. Tap one to open the run. A `w.notify` with `{ importance: "low" }` stays in the app.
