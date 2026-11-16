import type { LiveEvent } from "@pulsewatch/shared";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { API_BASE, refreshSession } from "../api/client";
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
    const pending = new Map<string, QueryKey>();

    const flush = setInterval(() => {
      for (const queryKey of pending.values()) void client.invalidateQueries({ queryKey });
      pending.clear();
    }, 1_000);

    function connect() {
      source = new EventSource(`${API_BASE}/events`);
      source.onopen = () => {
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
        // up for good after an error response such as 401 (expired access
        // token). In that case renew the session and open a new stream.
        if (source?.readyState === EventSource.CLOSED && !stopped) {
          source.close();
          reconnectTimer = setTimeout(() => {
            void refreshSession().then(() => {
              if (!stopped) connect();
            });
          }, 5_000);
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
