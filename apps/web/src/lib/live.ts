import type { LiveEvent } from "@pulsewatch/shared";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, API_BASE } from "../api/client";
import { keys } from "../api/hooks";

export type LiveState = "connecting" | "live" | "offline";

const EVENT_TYPES: LiveEvent["type"][] = [
  "check.completed",
  "monitor.status_changed",
  "incident.opened",
  "incident.resolved",
];

/** Which cached queries an event makes stale. */
function staleKeys(event: LiveEvent): QueryKey[] {
  const monitor = keys.monitor(event.monitorId);
  if (event.type === "check.completed" || event.type === "monitor.status_changed") {
    return [keys.dashboard, monitor];
  }
  return [keys.dashboard, monitor, ["incidents"]];
}

/**
 * Keeps the dashboard current using the API's Server-Sent Events stream
 * (ADR-006). Events only say "something changed"; the affected queries are
 * then refetched from the API, which stays the source of truth.
 *
 * Invalidations are batched once a second: with many monitors, checks finish
 * every few seconds and refetching on each one would waste requests.
 */
export function useLiveUpdates(): LiveState {
  const client = useQueryClient();
  const [state, setState] = useState<LiveState>("connecting");

  useEffect(() => {
    let source: EventSource | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let failures = 0;
    const pending = new Map<string, QueryKey>();

    const flush = setInterval(() => {
      for (const queryKey of pending.values()) void client.invalidateQueries({ queryKey });
      pending.clear();
    }, 1_000);

    function connect() {
      source = new EventSource(`${API_BASE}/events`);
      source.onopen = () => {
        failures = 0;
        setState("live");
      };
      for (const type of EVENT_TYPES) {
        source.addEventListener(type, (message) => {
          const event = JSON.parse((message as MessageEvent<string>).data) as LiveEvent;
          for (const key of staleKeys(event)) pending.set(JSON.stringify(key), key);
        });
      }
      source.onerror = () => {
        setState("offline");
        // EventSource retries by itself after a dropped connection, but gives
        // up for good after an error response: 401 (access token expired) or
        // 429 (too many open streams, e.g. many tabs). It cannot tell which,
        // so ask the API: GET /auth/me renews the session only if it really
        // has expired. Refreshing unconditionally would rotate the refresh
        // token on every attempt. Retries back off from 5 s to 60 s.
        if (source?.readyState === EventSource.CLOSED && !stopped) {
          source.close();
          failures += 1;
          const delay = Math.min(60_000, 5_000 * 2 ** (failures - 1));
          reconnectTimer = setTimeout(() => {
            api
              .get("/auth/me")
              .catch(() => undefined)
              .finally(() => {
                if (!stopped) connect();
              });
          }, delay);
        }
      };
    }

    connect();
    return () => {
      stopped = true;
      clearInterval(flush);
      clearTimeout(reconnectTimer);
      source?.close();
    };
  }, [client]);

  return state;
}
