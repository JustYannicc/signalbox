import { describe, expect, it } from "vite-plus/test";
import { sqliteFixture } from "./sqliteTesting.ts";

describe("computer SQLite fixture", () => {
  it("executes repeated writes and reads with fresh scalar and binary bindings", () => {
    const fixture = sqliteFixture();
    const sql = fixture.storage.sql;
    try {
      expect(sql.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, bytes BLOB)")).toEqual([]);
      for (const id of [1, 2]) {
        expect(
          sql.exec("INSERT INTO entries VALUES (?, ?)", id, new Uint8Array([id]).buffer),
        ).toEqual([]);
      }
      expect(sql.exec("SELECT bytes FROM entries WHERE id = ?", 1)).toEqual([
        { bytes: new Uint8Array([1]) },
      ]);
      expect(sql.exec("SELECT bytes FROM entries WHERE id = ?", 2)).toEqual([
        { bytes: new Uint8Array([2]) },
      ]);
      expect(sql.exec("UPDATE entries SET id = id + 10 RETURNING id")).toEqual([
        { id: 11 },
        { id: 12 },
      ]);
    } finally {
      fixture.close();
    }
  });

  it("reads new columns after a schema change and recovers a failed statement", () => {
    const fixture = sqliteFixture();
    const sql = fixture.storage.sql;
    try {
      sql.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY)");
      sql.exec("INSERT INTO entries VALUES (?)", 1);
      expect(sql.exec("SELECT * FROM entries")).toEqual([{ id: 1 }]);
      sql.exec("ALTER TABLE entries ADD COLUMN label TEXT DEFAULT 'new'");
      expect(sql.exec("SELECT * FROM entries")).toEqual([{ id: 1, label: "new" }]);
      expect(() => sql.exec("INSERT INTO entries (id) VALUES (?)", 1)).toThrow();
      expect(sql.exec("INSERT INTO entries (id) VALUES (?)", 2)).toEqual([]);
      expect(sql.exec("SELECT id FROM entries ORDER BY id")).toEqual([{ id: 1 }, { id: 2 }]);
    } finally {
      fixture.close();
    }
  });

  it("rolls back inner and outer transactions without retaining stale statement bindings", () => {
    const fixture = sqliteFixture();
    const sql = fixture.storage.sql;
    try {
      sql.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY)");
      fixture.storage.transactionSync(() => {
        sql.exec("INSERT INTO entries VALUES (?)", 1);
        expect(() =>
          fixture.storage.transactionSync(() => {
            sql.exec("INSERT INTO entries VALUES (?)", 2);
            throw new Error("inner rollback");
          }),
        ).toThrow("inner rollback");
        sql.exec("INSERT INTO entries VALUES (?)", 3);
      });
      expect(() =>
        fixture.storage.transactionSync(() => {
          sql.exec("INSERT INTO entries VALUES (?)", 4);
          throw new Error("outer rollback");
        }),
      ).toThrow("outer rollback");
      expect(sql.exec("SELECT id FROM entries ORDER BY id")).toEqual([{ id: 1 }, { id: 3 }]);
    } finally {
      fixture.close();
    }
  });

  it("refreshes result columns after rolled-back DDL and the next schema change", () => {
    const fixture = sqliteFixture();
    const sql = fixture.storage.sql;
    try {
      sql.exec("CREATE TABLE entries (id INTEGER)");
      sql.exec("INSERT INTO entries VALUES (1)");
      expect(() =>
        fixture.storage.transactionSync(() => {
          sql.exec("ALTER TABLE entries ADD COLUMN temporary TEXT DEFAULT 'rollback'");
          expect(sql.exec("SELECT * FROM entries")).toEqual([{ id: 1, temporary: "rollback" }]);
          throw new Error("rollback DDL");
        }),
      ).toThrow("rollback DDL");
      expect(sql.exec("SELECT * FROM entries")).toEqual([{ id: 1 }]);
      sql.exec("ALTER TABLE entries ADD COLUMN permanent TEXT DEFAULT 'committed'");
      expect(sql.exec("SELECT * FROM entries")).toEqual([{ id: 1, permanent: "committed" }]);
    } finally {
      fixture.close();
    }
  });

  it("keeps statement and schema state local to each database and closes it independently", () => {
    const first = sqliteFixture();
    const second = sqliteFixture();
    try {
      try {
        first.storage.sql.exec("CREATE TABLE entries (first TEXT DEFAULT 'one')");
        second.storage.sql.exec("CREATE TABLE entries (second TEXT DEFAULT 'two')");
        first.storage.sql.exec("INSERT INTO entries DEFAULT VALUES");
        second.storage.sql.exec("INSERT INTO entries DEFAULT VALUES");
        expect(first.storage.sql.exec("SELECT * FROM entries")).toEqual([{ first: "one" }]);
        expect(second.storage.sql.exec("SELECT * FROM entries")).toEqual([{ second: "two" }]);
      } finally {
        first.close();
      }
      expect(() => first.storage.sql.exec("SELECT * FROM entries")).toThrow();
      expect(second.storage.sql.exec("SELECT * FROM entries")).toEqual([{ second: "two" }]);
    } finally {
      second.close();
    }
  });
});
