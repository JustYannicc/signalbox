import { describe, expect, it } from "@effect/vitest";
import { FolderId } from "@t3tools/contracts/signalboxFolders";
import * as Effect from "effect/Effect";

import { catalogHomeKey } from "./catalogHome.ts";
import { catalogPersonalRoot } from "./catalogPersonalRoot.ts";
import { organizationHome } from "./tests/organizationContext.ts";
import {
  bootstrapped,
  denied,
  freshRoot,
  invalidState,
  member,
  openState,
  org,
  top,
} from "./tests/organizationFixtures.ts";
import {
  childLevel,
  childRow,
  organizationLifecycle,
  personalLifecycle,
  ref,
} from "./tests/lifecycleFixtures.ts";

const create = org.changes.createFolder.run;
const retire = org.changes.retireFolder.run;
const reopen = org.changes.reopenFolder.run;
const children = org.views.children.run;
const access = org.views.access.run;
const orgOwner = organizationHome().owner;
const members = [member("ada", ["member"]), member("bea", ["admin"])];
const named = (id: string, name = id) => ({ level: childLevel(orgOwner, id), name });
const make = (parent: { folderId: FolderId | null; incarnation: number }, id: string) => ({
  parent,
  folderId: FolderId.make(id),
  name: id,
});

describe("catalog folder lifecycle", () => {
  it.effect("members see the same canonical folders an admin creates; viewers cannot add", () =>
    Effect.gen(function* () {
      const context = organizationLifecycle({ ...bootstrapped(), memberships: members });
      const created = yield* create(context.as("bea"), make(top, "plans"));
      expect(created).toEqual({ level: childLevel(orgOwner, "plans") });
      expect("legacySource" in created.level.home).toBe(false);
      yield* create(context.as("bea"), make(top, "notes"));

      const listing = { children: [named("plans"), named("notes")], next: null };
      expect(yield* children(context.as("ada"), { parent: top, after: null })).toEqual(listing);
      expect(yield* children(context.as("bea"), { parent: top, after: null })).toEqual(listing);
      expect(yield* access(context.as("ada"), ref("plans"))).toEqual({ role: "Viewer" });

      yield* denied(create(context.as("ada"), make(top, "mine")));
      yield* denied(create(context.as("eve"), make(top, "mine")));
      yield* denied(children(context.as("eve"), { parent: top, after: null }));
      expect(context.folders.rows().map(({ id }) => id)).toEqual(["plans", "notes"]);
      expect(context.root.rows()[0]).toEqual(freshRoot({ topologyRevision: 2 }));
      expect(context.state.rows()[0]?.revision).toBe(2);
      // Creating adds a level without changing anyone's existing access.
      expect(context.fences).toEqual([]);
    }),
  );

  it.effect("direct grants on a new folder inherit downward and revocation removes them", () =>
    Effect.gen(function* () {
      const context = organizationLifecycle({ ...bootstrapped(), memberships: members });
      yield* create(context.as("bea"), make(top, "plans"));
      const setGrant = (role: "Admin" | null) =>
        org.changes.setGrant.run(context.as("bea"), {
          target: ref("plans"),
          personId: "ada",
          role,
        });

      yield* setGrant("Admin");
      const nested = yield* create(context.as("ada"), make(ref("plans"), "q3"));
      expect(nested).toEqual({ level: childLevel(orgOwner, "q3") });
      expect(yield* access(context.as("ada"), ref("q3"))).toEqual({ role: "Admin" });
      yield* denied(create(context.as("ada"), make(top, "elsewhere")));

      yield* setGrant(null);
      yield* denied(create(context.as("ada"), make(ref("plans"), "q4")));
      expect(yield* children(context.as("ada"), { parent: ref("plans"), after: null })).toEqual({
        children: [named("q3")],
        next: null,
      });
      expect(context.fences.map(({ epoch }) => epoch)).toEqual([1, 2]);
    }),
  );

  it.effect("refuses stale parents, foreign roots and any existing id, including tombstones", () =>
    Effect.gen(function* () {
      const context = organizationLifecycle({
        ...bootstrapped(),
        memberships: members,
        folders: [
          childRow("plans", { incarnation: 2 }),
          childRow("gone", { position: 1, state: "deleted" }),
          childRow("orphan", { parentId: "ghost", position: 0 }),
        ],
      });
      const before = context.folders.rows();
      yield* denied(create(context.as("bea"), make(ref("plans", 1), "fresh")));
      yield* denied(create(context.as("bea"), make({ folderId: null, incarnation: 2 }, "fresh")));
      yield* denied(create(context.as("bea"), make(top, "plans")));
      yield* denied(create(context.as("bea"), make(top, "gone")));
      // Children already pointing at the id would be adopted by the new level.
      yield* invalidState(create(context.as("bea"), make(top, "ghost")));
      expect(context.folders.rows()).toEqual(before);
      expect(context.root.rows()[0]).toEqual(freshRoot());

      const foreign = organizationLifecycle({
        state: [openState(organizationHome("org_two"))],
        root: [freshRoot()],
        memberships: members,
      });
      yield* invalidState(create(foreign.as("bea"), make(top, "fresh")));
      yield* invalidState(children(foreign.as("bea"), { parent: top, after: null }));
      expect(foreign.folders.rows()).toEqual([]);
    }),
  );

  it.effect("retiring hides the subtree and reopening resumes the same level and grants", () =>
    Effect.gen(function* () {
      const context = organizationLifecycle({ ...bootstrapped(), memberships: members });
      yield* create(context.as("bea"), make(top, "plans"));
      yield* create(context.as("bea"), make(top, "notes"));
      yield* create(context.as("bea"), make(ref("plans"), "q3"));
      yield* org.changes.setGrant.run(context.as("bea"), {
        target: ref("q3"),
        personId: "ada",
        role: "Member",
      });

      yield* denied(retire(context.as("ada"), { target: ref("plans") }));
      expect(yield* retire(context.as("bea"), { target: ref("plans") })).toEqual({ changed: true });
      expect(yield* retire(context.as("bea"), { target: ref("plans") })).toEqual({
        changed: false,
      });
      yield* denied(retire(context.as("bea"), { target: ref("plans", 2) }));
      expect(yield* children(context.as("ada"), { parent: top, after: null })).toEqual({
        children: [named("notes")],
        next: null,
      });
      yield* denied(access(context.as("ada"), ref("q3")));
      yield* denied(children(context.as("bea"), { parent: ref("plans"), after: null }));
      yield* denied(create(context.as("bea"), make(ref("plans"), "q4")));
      // A descendant of a retired level has no current parent to act through.
      yield* denied(retire(context.as("bea"), { target: ref("q3") }));

      yield* denied(reopen(context.as("ada"), { target: ref("plans") }));
      yield* denied(reopen(context.as("bea"), { target: ref("plans", 2) }));
      expect(yield* reopen(context.as("bea"), { target: ref("plans") })).toEqual({ changed: true });
      expect(yield* children(context.as("ada"), { parent: top, after: null })).toEqual({
        children: [named("plans"), named("notes")],
        next: null,
      });
      expect(yield* access(context.as("ada"), ref("q3"))).toEqual({ role: "Member" });
      expect(context.folders.rows().find(({ id }) => id === "plans")).toMatchObject({
        incarnation: 1,
        position: 0,
        state: "active",
      });
      const scope = catalogHomeKey(context.projection.home);
      expect(context.fences).toEqual([
        { scope, epoch: 1 },
        { scope, epoch: 2 },
        { scope, epoch: 3 },
      ]);
    }),
  );

  it.effect("pages more than one table page of siblings in creation order", () =>
    Effect.gen(function* () {
      const context = organizationLifecycle({ ...bootstrapped(), memberships: members });
      const ids = Array.from({ length: 123 }, (_, at) => `sibling-${String(at).padStart(3, "0")}`);
      for (const id of ids.toReversed()) yield* create(context.as("bea"), make(top, id));
      yield* retire(context.as("bea"), { target: ref(ids[122]!) });
      yield* retire(context.as("bea"), { target: ref(ids[20]!) });

      const first = yield* children(context.as("ada"), { parent: top, after: null });
      const visible = ids.toReversed().filter((id) => id !== ids[122] && id !== ids[20]);
      expect(first.children).toEqual(visible.slice(0, 100).map((id) => named(id)));
      expect(first.next).toEqual(ref(visible[99]!));

      // Retiring the cursor's folder between pages must not break or repeat the listing.
      yield* retire(context.as("bea"), { target: ref(visible[99]!) });
      const second = yield* children(context.as("ada"), { parent: top, after: first.next });
      expect(second).toEqual({ children: visible.slice(100).map((id) => named(id)), next: null });
      yield* denied(children(context.as("ada"), { parent: top, after: ref("missing") }));
      yield* denied(children(context.as("ada"), { parent: top, after: ref(visible[0]!, 2) }));
    }),
  );

  it.effect("refuses writes that would overflow revisions, epochs or sibling positions", () =>
    Effect.gen(function* () {
      const max = Number.MAX_SAFE_INTEGER;
      const full = (extra: { state?: object; root?: object }, folders: Array<object> = []) =>
        organizationLifecycle({ ...bootstrapped(extra), memberships: members, folders });

      yield* invalidState(create(full({ state: { revision: max } }).as("bea"), make(top, "a")));
      yield* invalidState(
        create(full({ root: { topologyRevision: max } }).as("bea"), make(top, "a")),
      );
      const crowded = full({}, [childRow("last", { position: max })]);
      yield* invalidState(create(crowded.as("bea"), make(top, "a")));
      expect(crowded.folders.rows()).toHaveLength(1);

      const epochs = full({ root: { authEpoch: max } }, [childRow("plans")]);
      expect(yield* create(epochs.as("bea"), make(top, "fresh"))).toEqual({
        level: childLevel(orgOwner, "fresh"),
      });
      yield* invalidState(retire(epochs.as("bea"), { target: ref("plans") }));
      expect(epochs.folders.rows()[0]?.state).toBe("active");
    }),
  );

  it.effect("personal roots run the same lifecycle with the person as owner", () =>
    Effect.gen(function* () {
      const personal = catalogPersonalRoot;
      const context = personalLifecycle();
      const owner = context.ctx.home.owner;
      expect(
        yield* personal.changes.createFolder.run(context.as("owner"), make(top, "home")),
      ).toEqual({ level: childLevel(owner, "home") });
      yield* denied(personal.views.children.run(context.as("guest"), { parent: top, after: null }));
      yield* denied(personal.changes.createFolder.run(context.as("guest"), make(top, "x")));

      yield* personal.changes.setGrant.run(context.as("owner"), {
        target: ref("home"),
        personId: "guest",
        role: "Viewer",
      });
      // Seeing above a granted folder is narrowed access (#247), not this slice.
      yield* denied(personal.views.children.run(context.as("guest"), { parent: top, after: null }));
      expect(
        yield* personal.views.children.run(context.as("guest"), {
          parent: ref("home"),
          after: null,
        }),
      ).toEqual({ children: [], next: null });
      yield* denied(personal.changes.createFolder.run(context.as("guest"), make(ref("home"), "x")));
      yield* denied(
        personal.changes.retireFolder.run(context.as("guest"), { target: ref("home") }),
      );

      yield* personal.changes.retireFolder.run(context.as("owner"), { target: ref("home") });
      yield* denied(personal.views.access.run(context.as("guest"), ref("home")));
      yield* personal.changes.reopenFolder.run(context.as("owner"), { target: ref("home") });
      expect(yield* personal.views.access.run(context.as("guest"), ref("home"))).toEqual({
        role: "Viewer",
      });
    }),
  );
});
