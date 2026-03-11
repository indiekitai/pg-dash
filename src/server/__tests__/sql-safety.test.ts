import { describe, it, expect } from "vitest";
import { isSafeFix } from "../advisor.js";

describe("isSafeFix", () => {
  describe("allowed operations", () => {
    it.each([
      "VACUUM",
      "VACUUM mytable",
      "VACUUM FULL public.mytable",
      "VACUUM ANALYZE mytable",
      "vacuum analyze",
      "Vacuum Analyze",
      "ANALYZE",
      "ANALYZE mytable",
      "REINDEX TABLE mytable",
      "REINDEX INDEX myindex",
      "CREATE INDEX CONCURRENTLY idx_foo ON bar (col)",
      "DROP INDEX CONCURRENTLY myindex",
      "SELECT pg_terminate_backend(123)",
      "SELECT pg_cancel_backend(123)",
      "EXPLAIN ANALYZE SELECT * FROM foo",
      "EXPLAIN ANALYZE SELECT count(*) FROM bar WHERE id > 5",
    ])("allows: %s", (sql) => {
      expect(isSafeFix(sql)).toBe(true);
    });
  });

  describe("rejected operations", () => {
    it.each([
      "DROP TABLE users",
      "DELETE FROM users",
      "UPDATE users SET admin = true",
      "INSERT INTO users VALUES (1)",
      "ALTER TABLE users DROP COLUMN id",
      "TRUNCATE users",
      "CREATE TABLE evil (id int)",
      "EXPLAIN ANALYZE DELETE FROM users",
      "EXPLAIN ANALYZE UPDATE users SET x = 1",
    ])("rejects: %s", (sql) => {
      expect(isSafeFix(sql)).toBe(false);
    });
  });

  describe("batch safe operations", () => {
    it.each([
      "VACUUM table1; VACUUM table2; VACUUM table3",
      "VACUUM ANALYZE t1; VACUUM ANALYZE t2",
      "ANALYZE t1; ANALYZE t2; ANALYZE t3;",
      "REINDEX TABLE t1; REINDEX TABLE t2",
    ])("allows batch safe: %s", (sql) => {
      expect(isSafeFix(sql)).toBe(true);
    });
  });

  describe("ALTER TABLE SET (storage params)", () => {
    it.each([
      "ALTER TABLE mytable SET (autovacuum_vacuum_threshold = 5, autovacuum_vacuum_scale_factor = 0.1)",
      "ALTER TABLE public.small_table SET (autovacuum_vacuum_threshold = 10)",
    ])("allows: %s", (sql) => {
      expect(isSafeFix(sql)).toBe(true);
    });

    it.each([
      "ALTER TABLE users DROP COLUMN id",
      "ALTER TABLE users ADD COLUMN evil text",
      "ALTER TABLE users RENAME TO hacked",
    ])("rejects: %s", (sql) => {
      expect(isSafeFix(sql)).toBe(false);
    });
  });

  describe("multi-statement injection", () => {
    it.each([
      "VACUUM; DROP TABLE users;",
      "VACUUM; DROP TABLE users",
      "ANALYZE; DELETE FROM users;",
      "VACUUM\n; DROP TABLE users",
    ])("rejects multi-statement with unsafe: %s", (sql) => {
      expect(isSafeFix(sql)).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("rejects empty string", () => {
      expect(isSafeFix("")).toBe(false);
    });

    it("rejects whitespace only", () => {
      expect(isSafeFix("   ")).toBe(false);
    });

    it("allows trailing semicolon on safe statement", () => {
      expect(isSafeFix("VACUUM;")).toBe(true);
    });

    it("allows trailing whitespace", () => {
      expect(isSafeFix("VACUUM   ")).toBe(true);
    });
  });
});
