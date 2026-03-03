import { describe, it, expect } from "vitest";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";

describe("WebSocket", () => {
  it("receives initial metrics snapshot on connection", async () => {
    const server = http.createServer();
    const wss = new WebSocketServer({ server, path: "/ws" });
    const mockSnapshot = { connections_total: 5, cache_hit_ratio: 0.99 };

    wss.on("connection", (ws) => {
      ws.send(JSON.stringify({ type: "metrics", data: mockSnapshot }));
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;

    const message = await new Promise<any>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      ws.on("message", (data) => {
        resolve(JSON.parse(data.toString()));
        ws.close();
      });
      ws.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), 3000);
    });

    expect(message.type).toBe("metrics");
    expect(message.data.connections_total).toBe(5);

    wss.close();
    server.close();
  });

  it("rejects connection without token when auth configured", async () => {
    const server = http.createServer();
    const wss = new WebSocketServer({
      server,
      path: "/ws",
      verifyClient: (info, cb) => {
        const url = new URL(info.req.url || "/", "http://localhost");
        if (url.searchParams.get("token") === "mysecret") return cb(true);
        cb(false, 401, "Unauthorized");
      },
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;

    // Without token — should fail
    const rejected = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`);
      ws.on("error", () => resolve(true));
      ws.on("unexpected-response", () => { ws.close(); resolve(true); });
      ws.on("open", () => { ws.close(); resolve(false); });
      setTimeout(() => resolve(true), 2000);
    });
    expect(rejected).toBe(true);

    // With token — should succeed
    const connected = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws?token=mysecret`);
      ws.on("open", () => { ws.close(); resolve(true); });
      ws.on("error", () => resolve(false));
      setTimeout(() => resolve(false), 2000);
    });
    expect(connected).toBe(true);

    wss.close();
    server.close();
  });
});
