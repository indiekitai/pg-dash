import { describe, it, expect } from "vitest";
import { computeAdvisorScore, gradeFromScore, isSafeFix, type AdvisorIssue } from "../advisor.js";

function issue(severity: AdvisorIssue["severity"], category: AdvisorIssue["category"] = "performance"): AdvisorIssue {
  return { id: `test-${Math.random()}`, severity, category, title: "test", description: "test", fix: "SELECT 1", impact: "test", effort: "quick" };
}

describe("computeAdvisorScore", () => {
  it("returns 100 for no issues", () => {
    expect(computeAdvisorScore([])).toBe(100);
  });

  it("deducts 15 for critical", () => {
    expect(computeAdvisorScore([issue("critical")])).toBe(85);
  });

  it("deducts 5 for warning", () => {
    expect(computeAdvisorScore([issue("warning")])).toBe(95);
  });

  it("deducts 1 for info", () => {
    expect(computeAdvisorScore([issue("info")])).toBe(99);
  });

  it("caps critical deductions at 60", () => {
    const issues = Array.from({ length: 20 }, () => issue("critical"));
    expect(computeAdvisorScore(issues)).toBe(40);
  });

  it("handles mixed severities", () => {
    // 100 - 15 - 5 - 1 = 79
    expect(computeAdvisorScore([issue("critical"), issue("warning"), issue("info")])).toBe(79);
  });

  it("caps warning deductions at 30", () => {
    // 19 warnings: first 3 at 5=15, next 7 at 2.5=17.5, next 9 at 1.25=11.25 => 43.75 but capped at 30
    const issues = Array.from({ length: 19 }, () => issue("warning"));
    expect(computeAdvisorScore(issues)).toBe(70);
  });

  it("gives B+ for only FK index warnings", () => {
    // A database with only 10 FK index warnings should score well
    const issues = Array.from({ length: 10 }, () => issue("warning", "schema"));
    const score = computeAdvisorScore(issues);
    expect(score).toBeGreaterThanOrEqual(70);
  });
});

describe("gradeFromScore", () => {
  it("A for 90+", () => expect(gradeFromScore(95)).toBe("A"));
  it("A for exactly 90", () => expect(gradeFromScore(90)).toBe("A"));
  it("B for 80-89", () => expect(gradeFromScore(85)).toBe("B"));
  it("C for 70-79", () => expect(gradeFromScore(75)).toBe("C"));
  it("D for 50-69", () => expect(gradeFromScore(60)).toBe("D"));
  it("F for <50", () => expect(gradeFromScore(30)).toBe("F"));
  it("F for 0", () => expect(gradeFromScore(0)).toBe("F"));
});

describe("isSafeFix", () => {
  it("allows VACUUM", () => expect(isSafeFix("VACUUM ANALYZE public.users;")).toBe(true));
  it("allows ANALYZE", () => expect(isSafeFix("ANALYZE public.users;")).toBe(true));
  it("allows REINDEX", () => expect(isSafeFix("REINDEX INDEX CONCURRENTLY idx_users_email;")).toBe(true));
  it("allows CREATE INDEX CONCURRENTLY", () => expect(isSafeFix("CREATE INDEX CONCURRENTLY idx_test ON t(c);")).toBe(true));
  it("allows DROP INDEX CONCURRENTLY", () => expect(isSafeFix("DROP INDEX CONCURRENTLY idx_test;")).toBe(true));
  it("allows pg_terminate_backend", () => expect(isSafeFix("SELECT pg_terminate_backend(123);")).toBe(true));
  it("allows pg_cancel_backend", () => expect(isSafeFix("SELECT pg_cancel_backend(123);")).toBe(true));
  it("allows EXPLAIN ANALYZE", () => expect(isSafeFix("EXPLAIN ANALYZE SELECT * FROM users;")).toBe(true));
  it("rejects DROP TABLE", () => expect(isSafeFix("DROP TABLE users;")).toBe(false));
  it("rejects DELETE", () => expect(isSafeFix("DELETE FROM users;")).toBe(false));
  it("rejects ALTER TABLE", () => expect(isSafeFix("ALTER TABLE users DROP COLUMN email;")).toBe(false));
  it("rejects SELECT (non pg_terminate)", () => expect(isSafeFix("SELECT * FROM users;")).toBe(false));
  it("case insensitive", () => expect(isSafeFix("vacuum analyze t;")).toBe(true));
  it("rejects empty", () => expect(isSafeFix("")).toBe(false));

  // SQL injection bypass tests
  it("rejects EXPLAIN ANALYZE DELETE", () => expect(isSafeFix("EXPLAIN ANALYZE DELETE FROM users;")).toBe(false));
  it("rejects EXPLAIN ANALYZE UPDATE", () => expect(isSafeFix("EXPLAIN ANALYZE UPDATE users SET name = 'x';")).toBe(false));
  it("rejects multi-statement with VACUUM", () => expect(isSafeFix("VACUUM; DROP TABLE users;")).toBe(false));
  it("rejects multi-statement with SELECT", () => expect(isSafeFix("SELECT pg_terminate_backend(1); DROP TABLE users;")).toBe(false));
  it("allows EXPLAIN ANALYZE SELECT", () => expect(isSafeFix("EXPLAIN ANALYZE SELECT * FROM users;")).toBe(true));
  it("rejects EXPLAIN ANALYZE INSERT", () => expect(isSafeFix("EXPLAIN ANALYZE INSERT INTO users VALUES (1);")).toBe(false));
});
