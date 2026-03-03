import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { isSafeFix } from "../advisor.js";

// Build a minimal Hono app that mirrors the real server's API routes with mocked PG
function createTestApp(opts: { auth?: string; token?: string } = {}) {
  const app = new Hono();

  const mockQueryResults: Record<string, any> = {
    overview: { version: "16.0", uptime: "1 day", connections: 5 },
    databases: [{ name: "testdb", size: "10MB" }],
    tables: [{ name: "users", rows: 100 }],
    activity: [{ pid: 1, state: "active", query: "SELECT 1" }],
    queries: [{ query: "SELECT 1", calls: 10 }],
    advisor: { score: 85, grade: "B", issues: [], breakdown: {} },
  };

  // Auth endpoint for cookie-based auth
  if (opts.token) {
    app.post("/api/auth", async (c) => {
      try {
        const body = await c.req.json();
        if (body?.token === opts.token) {
          c.header("Set-Cookie", `pg-dash-token=${opts.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
          return c.json({ ok: true });
        }
        return c.json({ error: "Invalid token" }, 401);
      } catch {
        return c.json({ error: "Invalid request" }, 400);
      }
    });
  }

  // Auth middleware
  if (opts.auth || opts.token) {
    app.use("*", async (c, next) => {
      const authHeader = c.req.header("authorization") || "";
      if (opts.token && authHeader === `Bearer ${opts.token}`) return next();
      if (opts.auth) {
        const [user, pass] = opts.auth.split(":");
        const expected = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
        if (authHeader === expected) return next();
      }
      // Check cookie
      if (opts.token) {
        const cookies = c.req.header("cookie") || "";
        const match = cookies.match(/(?:^|;\s*)pg-dash-token=([^;]*)/);
        if (match && match[1] === opts.token) return next();
      }
      if (opts.auth) c.header("WWW-Authenticate", 'Basic realm="pg-dash"');
      return c.text("Unauthorized", 401);
    });
  }

  app.get("/api/overview", (c) => c.json(mockQueryResults.overview));
  app.get("/api/databases", (c) => c.json(mockQueryResults.databases));
  app.get("/api/tables", (c) => c.json(mockQueryResults.tables));
  app.get("/api/activity", (c) => c.json(mockQueryResults.activity));
  app.get("/api/queries", (c) => c.json(mockQueryResults.queries));
  app.get("/api/advisor", (c) => c.json(mockQueryResults.advisor));
  app.get("/api/metrics/latest", (c) => c.json({ connections_total: 5, cache_hit_ratio: 0.99 }));
  app.get("/api/metrics", (c) => {
    const metric = c.req.query("metric");
    if (!metric) return c.json({ error: "metric param required" }, 400);
    return c.json([]);
  });

  app.post("/api/fix", async (c) => {
    const body = await c.req.json();
    const sql = body?.sql?.trim();
    if (!sql) return c.json({ error: "sql field required" }, 400);
    if (!isSafeFix(sql)) return c.json({ error: "Operation not allowed" }, 403);
    return c.json({ ok: true, duration: 10, rowCount: 0, rows: [] });
  });

  app.get("/api/schema/tables", (c) => c.json([]));
  app.get("/api/schema/indexes", (c) => c.json([]));
  app.get("/api/schema/functions", (c) => c.json([]));
  app.get("/api/schema/extensions", (c) => c.json([]));
  app.get("/api/schema/enums", (c) => c.json([]));
  app.get("/api/schema/history", (c) => c.json([]));
  app.get("/api/schema/changes", (c) => c.json([]));
  app.get("/api/schema/changes/latest", (c) => c.json([]));
  app.get("/api/alerts/rules", (c) => c.json([]));
  app.get("/api/alerts/history", (c) => c.json([]));

  return app;
}

describe("API endpoints", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp();
  });

  describe("GET endpoints return JSON", () => {
    it.each([
      "/api/overview",
      "/api/databases",
      "/api/tables",
      "/api/activity",
      "/api/queries",
      "/api/advisor",
      "/api/metrics/latest",
      "/api/schema/tables",
      "/api/schema/indexes",
      "/api/schema/functions",
      "/api/schema/extensions",
      "/api/schema/enums",
      "/api/schema/history",
      "/api/schema/changes",
      "/api/schema/changes/latest",
      "/api/alerts/rules",
      "/api/alerts/history",
    ])("GET %s returns 200", async (path) => {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toBeDefined();
    });
  });

  describe("GET /api/metrics", () => {
    it("returns 400 without metric param", async () => {
      const res = await app.request("/api/metrics");
      expect(res.status).toBe(400);
    });

    it("returns 200 with metric param", async () => {
      const res = await app.request("/api/metrics?metric=connections_total");
      expect(res.status).toBe(200);
    });
  });

  describe("POST /api/fix", () => {
    it("returns 400 without sql", async () => {
      const res = await app.request("/api/fix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("returns 403 for unsafe SQL", async () => {
      const res = await app.request("/api/fix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: "DROP TABLE users" }),
      });
      expect(res.status).toBe(403);
    });

    it("returns 200 for safe SQL", async () => {
      const res = await app.request("/api/fix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: "VACUUM ANALYZE" }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
    });
  });
});

describe("Auth middleware", () => {
  it("returns 401 without credentials when token is set", async () => {
    const app = createTestApp({ token: "secret123" });
    const res = await app.request("/api/overview");
    expect(res.status).toBe(401);
  });

  it("returns 200 with correct bearer token", async () => {
    const app = createTestApp({ token: "secret123" });
    const res = await app.request("/api/overview", {
      headers: { Authorization: "Bearer secret123" },
    });
    expect(res.status).toBe(200);
  });

  it("returns 401 with wrong bearer token", async () => {
    const app = createTestApp({ token: "secret123" });
    const res = await app.request("/api/overview", {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 200 with correct basic auth", async () => {
    const app = createTestApp({ auth: "admin:pass" });
    const creds = Buffer.from("admin:pass").toString("base64");
    const res = await app.request("/api/overview", {
      headers: { Authorization: `Basic ${creds}` },
    });
    expect(res.status).toBe(200);
  });

  it("returns 401 with wrong basic auth", async () => {
    const app = createTestApp({ auth: "admin:pass" });
    const creds = Buffer.from("admin:wrong").toString("base64");
    const res = await app.request("/api/overview", {
      headers: { Authorization: `Basic ${creds}` },
    });
    expect(res.status).toBe(401);
  });

  it("returns 200 with correct cookie token", async () => {
    const app = createTestApp({ token: "secret123" });
    const res = await app.request("/api/overview", {
      headers: { Cookie: "pg-dash-token=secret123" },
    });
    expect(res.status).toBe(200);
  });

  it("returns 401 with wrong cookie token", async () => {
    const app = createTestApp({ token: "secret123" });
    const res = await app.request("/api/overview", {
      headers: { Cookie: "pg-dash-token=wrong" },
    });
    expect(res.status).toBe(401);
  });

  it("POST /api/auth sets cookie with correct token", async () => {
    const app = createTestApp({ token: "secret123" });
    const res = await app.request("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "secret123" }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") || "";
    expect(setCookie).toContain("pg-dash-token=secret123");
  });

  it("POST /api/auth returns 401 with wrong token", async () => {
    const app = createTestApp({ token: "secret123" });
    const res = await app.request("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "wrong" }),
    });
    expect(res.status).toBe(401);
  });
});
