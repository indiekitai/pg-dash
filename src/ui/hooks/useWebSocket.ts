import { useEffect, useState } from "react";
import type { ActivityRow, FiredAlert } from "../types";

export function useWebSocket() {
  const [metrics, setMetrics] = useState<Record<string, number>>({});
  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [alerts, setAlerts] = useState<FiredAlert[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let backoff = 1000;
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${location.host}/ws`);
      ws.onopen = () => { setConnected(true); backoff = 1000; };
      ws.onclose = () => { setConnected(false); reconnectTimer = setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 30000); };
      ws.onerror = () => ws?.close();
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "metrics") setMetrics(msg.data);
          if (msg.type === "activity") setActivity(msg.data);
          if (msg.type === "alerts") {
            setAlerts(prev => [...msg.data, ...prev].slice(0, 100));
          }
        } catch (e) { console.error(e); }
      };
    };
    connect();
    return () => { clearTimeout(reconnectTimer); ws?.close(); };
  }, []);

  return { metrics, activity, alerts, connected };
}
