/**
 * Live events pushed to the dashboard (ADR-006).
 *
 * The worker publishes them to one Redis channel after its transaction
 * commits; every API instance subscribes and forwards each event to that
 * user's open Server-Sent Events connections. Events are a hint to refetch,
 * never the data of record: a missed event only delays an update.
 */
export const EVENTS_CHANNEL = "pulsewatch:events";

export type MonitorStatusValue = "PENDING" | "UP" | "DOWN";

export type LiveEvent =
  | { type: "check.completed"; monitorId: string; success: boolean; scheduledFor: string }
  | { type: "monitor.status_changed"; monitorId: string; status: MonitorStatusValue }
  | { type: "incident.opened"; monitorId: string; incidentId: string }
  | { type: "incident.resolved"; monitorId: string; incidentId: string };

/** What actually travels over Redis: the event plus who it is for. */
export interface EventEnvelope {
  userId: string;
  event: LiveEvent;
}
