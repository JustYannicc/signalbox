# Context: domain terms in this model

One line each. Element kinds in `spec.c4` use these words and no others.

| Term           | Meaning                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| top level      | A person's root level: one per person, owned by that person. Kind `toplevel`.                                       |
| folder         | Any level below a top level. Folders nest freely. Kind `folder`.                                                    |
| thread         | The durable unit of work (chat or task is display only), filed in one folder. Kind `thread`.                        |
| owner          | Who owns a level or custody object: a person or an organization. Metadata `owner`, or an `owns` relationship.       |
| organization   | A WorkOS organization. Only ever the owner of a folder, never a level.                                              |
| role           | Owner, Admin, Member or Viewer on a folder, inherited down. A relationship from a person.                           |
| mount          | Puts an organization-owned folder into a member's tree, under their Work folder. The only edge across owners.       |
| placement      | A thing (pool, connection, secret reference, skill, AGENTS.md, automation, drive) put on a level.                   |
| reach          | A placement reaches its level and everything below; the nearest wins. Never depends on who sends.                   |
| loan           | An explicit, revocable placement into a level the lender does not own. The only way to use what is not above you.   |
| assistant      | The agent thread of a person's top level. Coordinates, never executes. Sits at the top layer.                       |
| pipeline lanes | A person's asks from every level they reach, in lanes Blocker, Ready, Considering. Top layer, beside the assistant. |
| ask            | The one needs-you record, raised by one thread, answered into that thread.                                          |
| pool           | An owned set of model subscriptions and API keys, placed on a level.                                                |
| connection     | One credential for one account of one service, placed on a level; its tools reach threads below.                    |
| computer       | The one machine a thread sees (files, shell, ports). Where it runs is hidden.                                       |
| Base           | A warm boxd snapshot of a repo drive's last green `main`; VMs fork it to run commands.                              |
| drive          | A file history with one writer for `main`; a placement kind.                                                        |
| module         | A deep module: a black box with a small interface (verbs) and I/O relationships.                                    |
| seam / adapter | Where a module can swap implementations; real only with two adapters.                                               |

## Not kinds

These words must never be an element kind, deployment node kind or level kind:

- org
- company
- project
- section
- environment

A "company" or "project" is a folder with a generic name. An organization appears only as an owner.
