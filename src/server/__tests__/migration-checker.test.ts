import { describe, it, expect } from "vitest";
import { analyzeMigration, type MigrationCheckResult } from "../migration-checker.js";

// ─── Static checks ───────────────────────────────────────────────────────────

describe("analyzeMigration — static checks", () => {
  // 1. CREATE INDEX without CONCURRENTLY → warning
  it("warns on CREATE INDEX without CONCURRENTLY", async () => {
    const result = await analyzeMigration(
      "CREATE INDEX idx_foo ON my_table (col);"
    );
    const issue = result.issues.find((i) => i.code === "INDEX_WITHOUT_CONCURRENTLY");
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe("warning");
    expect(issue!.tableName).toBe("my_table");
  });

  // 2. CREATE INDEX CONCURRENTLY → info
  it("reports info for CREATE INDEX CONCURRENTLY", async () => {
    const result = await analyzeMigration(
      "CREATE INDEX CONCURRENTLY idx_foo ON my_table (col);"
    );
    const issue = result.issues.find((i) => i.code === "INDEX_CONCURRENTLY_OK");
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe("info");
  });

  // 3. ADD COLUMN NOT NULL without DEFAULT → error
  it("errors on ADD COLUMN NOT NULL without DEFAULT", async () => {
    const result = await analyzeMigration(
      "ALTER TABLE users ADD COLUMN email TEXT NOT NULL;"
    );
    const issue = result.issues.find((i) => i.code === "ADD_COLUMN_NOT_NULL_NO_DEFAULT");
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe("error");
    expect(issue!.tableName).toBe("users");
  });

  // 4. ADD COLUMN with NOT NULL + DEFAULT → warning
  it("warns on ADD COLUMN NOT NULL with DEFAULT", async () => {
    const result = await analyzeMigration(
      "ALTER TABLE users ADD COLUMN active BOOLEAN NOT NULL DEFAULT false;"
    );
    const issue = result.issues.find((i) => i.code === "ADD_COLUMN_REWRITES_TABLE");
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe("warning");
  });

  // ADD COLUMN nullable (no NOT NULL) → no error/warning
  it("does not warn on ADD COLUMN nullable with no constraints", async () => {
    const result = await analyzeMigration(
      "ALTER TABLE users ADD COLUMN bio TEXT;"
    );
    const addColIssues = result.issues.filter((i) =>
      i.code === "ADD_COLUMN_NOT_NULL_NO_DEFAULT" || i.code === "ADD_COLUMN_REWRITES_TABLE"
    );
    expect(addColIssues).toHaveLength(0);
  });

  // 5. DROP TABLE → warning
  it("warns on DROP TABLE", async () => {
    const result = await analyzeMigration("DROP TABLE old_logs;");
    const issue = result.issues.find((i) => i.code === "DROP_TABLE");
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe("warning");
  });

  // 6. TRUNCATE → warning
  it("warns on TRUNCATE", async () => {
    const result = await analyzeMigration("TRUNCATE sessions;");
    const issue = result.issues.find((i) => i.code === "TRUNCATE_TABLE");
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe("warning");
  });

  // 7. DELETE without WHERE → warning
  it("warns on DELETE FROM without WHERE", async () => {
    const result = await analyzeMigration("DELETE FROM temp_data;");
    const issue = result.issues.find((i) => i.code === "DELETE_WITHOUT_WHERE");
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe("warning");
  });

  // DELETE with WHERE → no warning
  it("does not warn on DELETE with WHERE", async () => {
    const result = await analyzeMigration(
      "DELETE FROM temp_data WHERE created_at < '2020-01-01';"
    );
    const issue = result.issues.find((i) => i.code === "DELETE_WITHOUT_WHERE");
    expect(issue).toBeUndefined();
  });

  // 8. UPDATE without WHERE → warning
  it("warns on UPDATE without WHERE", async () => {
    const result = await analyzeMigration(
      "UPDATE users SET status = 'active';"
    );
    const issue = result.issues.find((i) => i.code === "UPDATE_WITHOUT_WHERE");
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe("warning");
  });

  // UPDATE with WHERE → no warning
  it("does not warn on UPDATE with WHERE", async () => {
    const result = await analyzeMigration(
      "UPDATE users SET status = 'active' WHERE id = 1;"
    );
    const issue = result.issues.find((i) => i.code === "UPDATE_WITHOUT_WHERE");
    expect(issue).toBeUndefined();
  });

  // 9. Mixed SQL file
  it("handles mixed multi-statement SQL", async () => {
    const sql = `
      CREATE INDEX idx_x ON foo (x);
      ALTER TABLE bar ADD COLUMN age INT NOT NULL;
      DROP TABLE legacy;
      TRUNCATE cache;
    `;
    const result = await analyzeMigration(sql);
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain("INDEX_WITHOUT_CONCURRENTLY");
    expect(codes).toContain("ADD_COLUMN_NOT_NULL_NO_DEFAULT");
    expect(codes).toContain("DROP_TABLE");
    expect(codes).toContain("TRUNCATE_TABLE");
  });

  // 10. safe=false when error exists
  it("safe=false when there is an error-level issue", async () => {
    const result = await analyzeMigration(
      "ALTER TABLE users ADD COLUMN role TEXT NOT NULL;"
    );
    expect(result.safe).toBe(false);
  });

  // 11. safe=true when only warnings/infos
  it("safe=true when there are only warnings/infos", async () => {
    const result = await analyzeMigration("DROP TABLE old_cache;");
    expect(result.safe).toBe(true);
    expect(result.summary.warnings).toBeGreaterThan(0);
    expect(result.summary.errors).toBe(0);
  });

  // 12. REFERENCES — static syntax check (no DB)
  it("captures REFERENCES table name for dynamic validation", async () => {
    // Static-only: without pool, no MISSING_TABLE error is raised
    const result = await analyzeMigration(`
      ALTER TABLE orders ADD COLUMN user_id INT;
      -- REFERENCES users
    `);
    // No MISSING_TABLE without pool — just verify no crash and result is valid
    expect(result).toHaveProperty("issues");
    expect(result).toHaveProperty("safe");
  });

  // 13. CREATE INDEX on table created in SAME migration → no warning
  it("does not warn on CREATE INDEX on table created within the same migration", async () => {
    const sql = `
      CREATE TABLE new_table (id SERIAL PRIMARY KEY, name TEXT);
      CREATE INDEX idx_name ON new_table (name);
    `;
    const result = await analyzeMigration(sql);
    const issue = result.issues.find((i) => i.code === "INDEX_WITHOUT_CONCURRENTLY");
    expect(issue).toBeUndefined();
  });

  // 14. Empty SQL → safe=true, 0 issues
  it("returns safe=true and 0 issues for empty SQL", async () => {
    const result = await analyzeMigration("");
    expect(result.safe).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.summary.errors).toBe(0);
    expect(result.summary.warnings).toBe(0);
    expect(result.summary.infos).toBe(0);
  });

  // Whitespace-only SQL
  it("returns safe=true for whitespace-only SQL", async () => {
    const result = await analyzeMigration("   \n   ");
    expect(result.safe).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  // 15. Summary counts are accurate
  it("summary counts match actual issues", async () => {
    const sql = `
      ALTER TABLE t ADD COLUMN x TEXT NOT NULL;
      DROP TABLE old;
      CREATE INDEX CONCURRENTLY idx_y ON t (y);
    `;
    const result = await analyzeMigration(sql);
    const { errors, warnings, infos } = result.summary;
    expect(errors).toBe(result.issues.filter((i) => i.severity === "error").length);
    expect(warnings).toBe(result.issues.filter((i) => i.severity === "warning").length);
    expect(infos).toBe(result.issues.filter((i) => i.severity === "info").length);
  });
});

// ─── Output format checks (via analyzeMigration result shape) ─────────────────

describe("analyzeMigration — result structure", () => {
  it("JSON structure has all required fields", async () => {
    const result: MigrationCheckResult = await analyzeMigration(
      "ALTER TABLE users ADD COLUMN score INT NOT NULL;"
    );
    expect(typeof result.safe).toBe("boolean");
    expect(Array.isArray(result.issues)).toBe(true);
    expect(typeof result.summary.errors).toBe("number");
    expect(typeof result.summary.warnings).toBe("number");
    expect(typeof result.summary.infos).toBe("number");
    expect(typeof result.checkedAt).toBe("string");
    // checkedAt should be a valid ISO string
    expect(new Date(result.checkedAt).toString()).not.toBe("Invalid Date");
  });

  it("each issue has required fields", async () => {
    const result = await analyzeMigration("DROP TABLE x; TRUNCATE y;");
    for (const issue of result.issues) {
      expect(["error", "warning", "info"]).toContain(issue.severity);
      expect(typeof issue.code).toBe("string");
      expect(typeof issue.message).toBe("string");
    }
  });
});

// ─── Comment stripping ───────────────────────────────────────────────────────

describe("comment stripping — no false positives", () => {
  it("ignores DROP TABLE mentioned in a single-line comment", async () => {
    const result = await analyzeMigration(
      "-- DROP TABLE users if needed\nALTER TABLE users ADD COLUMN notes TEXT;"
    );
    expect(result.safe).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("ignores UPDATE without WHERE mentioned in a block comment", async () => {
    const result = await analyzeMigration(
      "/* UPDATE users SET foo = 1 is dangerous */\nALTER TABLE posts ADD COLUMN slug TEXT;"
    );
    expect(result.safe).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("still detects real DROP TABLE after a comment", async () => {
    const result = await analyzeMigration(
      "-- cleanup old table\nDROP TABLE old_data;"
    );
    const drop = result.issues.find((i) => i.code === "DROP_TABLE");
    expect(drop).toBeDefined();
    expect(drop?.lineNumber).toBe(2);
  });

  it("line numbers are accurate after comment stripping", async () => {
    const sql = [
      "-- comment line 1",
      "-- comment line 2",
      "CREATE INDEX idx_x ON users (email);",
    ].join("\n");
    const result = await analyzeMigration(sql);
    const issue = result.issues.find((i) => i.code === "INDEX_WITHOUT_CONCURRENTLY");
    expect(issue?.lineNumber).toBe(3);
  });
});

// ─── MD format check ──────────────────────────────────────────────────────────

describe("advanced checks — ALTER TYPE, DROP COLUMN, ADD CONSTRAINT, CONCURRENTLY in txn", () => {
  it("warns on ALTER COLUMN TYPE", async () => {
    const result = await analyzeMigration(
      "ALTER TABLE users ALTER COLUMN age TYPE BIGINT;"
    );
    const issue = result.issues.find((i) => i.code === "ALTER_COLUMN_TYPE");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("warning");
    expect(issue?.tableName).toBe("users");
  });

  it("reports info on DROP COLUMN", async () => {
    const result = await analyzeMigration(
      "ALTER TABLE users DROP COLUMN legacy_field;"
    );
    const issue = result.issues.find((i) => i.code === "DROP_COLUMN");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("info");
  });

  it("warns on ADD CONSTRAINT without NOT VALID", async () => {
    const result = await analyzeMigration(
      "ALTER TABLE orders ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id);"
    );
    const issue = result.issues.find((i) => i.code === "ADD_CONSTRAINT_SCANS_TABLE");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("warning");
  });

  it("does not warn on ADD CONSTRAINT ... NOT VALID", async () => {
    const result = await analyzeMigration(
      "ALTER TABLE orders ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id) NOT VALID;"
    );
    const issue = result.issues.find((i) => i.code === "ADD_CONSTRAINT_SCANS_TABLE");
    expect(issue).toBeUndefined();
  });

  it("errors on CREATE INDEX CONCURRENTLY inside a transaction", async () => {
    const result = await analyzeMigration(
      "BEGIN;\nCREATE INDEX CONCURRENTLY idx_users_email ON users (email);\nCOMMIT;"
    );
    const issue = result.issues.find((i) => i.code === "CONCURRENTLY_IN_TRANSACTION");
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe("error");
  });

  it("does not error CONCURRENTLY_IN_TRANSACTION when no transaction wrapper", async () => {
    const result = await analyzeMigration(
      "CREATE INDEX CONCURRENTLY idx_users_email ON users (email);"
    );
    const issue = result.issues.find((i) => i.code === "CONCURRENTLY_IN_TRANSACTION");
    expect(issue).toBeUndefined();
  });
});

describe("formatMarkdown output", () => {
  it("md output should contain table header and result row", async () => {
    const result = await analyzeMigration(
      "ALTER TABLE users ADD COLUMN x TEXT NOT NULL;"
    );
    // Simulate what the CLI would produce in md format
    const lines: string[] = [];
    lines.push("## 🔍 Migration Safety Check\n");
    lines.push("| Severity | Code | Message |");
    lines.push("|----------|------|---------|");
    for (const issue of result.issues) {
      const sev =
        issue.severity === "error"
          ? "🔴 ERROR"
          : issue.severity === "warning"
          ? "⚠️ WARNING"
          : "ℹ️ INFO";
      lines.push(`| ${sev} | ${issue.code} | ${issue.message} |`);
    }
    const output = lines.join("\n");
    expect(output).toContain("| Severity | Code | Message |");
    expect(output).toContain("ADD_COLUMN_NOT_NULL_NO_DEFAULT");
    expect(output).toContain("🔴 ERROR");
  });
});
