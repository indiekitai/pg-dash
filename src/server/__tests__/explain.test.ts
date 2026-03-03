import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { registerExplainRoutes } from "../routes/explain.js";

function makeMockPool(queryFn?: Function) {
  const client = {
    query: queryFn || vi.fn().mockResolvedValue({ rows: [{ "QUERY PLAN": [{ Plan: { "Node Type": "Seq Scan" } }] }] }),
    release: vi.fn(),
  };
  return { connect: vi.fn().mockResolvedValue(client), _client: client } as any;
}

describe("explain endpoint", () => {
  it("rejects DDL statements", async () => {
    const app = new Hono();
    registerExplainRoutes(app, makeMockPool());

    for (const ddl of ["DROP TABLE users", "CREATE INDEX foo", "ALTER TABLE x ADD COLUMN y int", "TRUNCATE users"]) {
      const res = await app.request("/api/explain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: ddl }),
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("DDL");
    }
  });

  it("rejects missing query", async () => {
    const app = new Hono();
    registerExplainRoutes(app, makeMockPool());
    const res = await app.request("/api/explain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("wraps in BEGIN/ROLLBACK", async () => {
    const calls: string[] = [];
    const queryFn = vi.fn().mockImplementation((q: any) => {
      const text = typeof q === "string" ? q : (q?.text || "");
      if (text) calls.push(text);
      if (text.startsWith("EXPLAIN")) {
        return { rows: [{ "QUERY PLAN": [{ Plan: { "Node Type": "Result" } }] }] };
      }
      return { rows: [] };
    });
    const app = new Hono();
    registerExplainRoutes(app, makeMockPool(queryFn));

    const res = await app.request("/api/explain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "SELECT 1" }),
    });
    expect(res.status).toBe(200);
    expect(calls).toContain("BEGIN");
    expect(calls).toContain("ROLLBACK");
    expect(calls.some(c => c.includes("EXPLAIN"))).toBe(true);
  });

  it("allows case-insensitive DDL detection", async () => {
    const app = new Hono();
    registerExplainRoutes(app, makeMockPool());
    const res = await app.request("/api/explain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "drop table users" }),
    });
    expect(res.status).toBe(400);
  });
});
