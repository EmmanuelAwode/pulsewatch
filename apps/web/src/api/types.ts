/**
 * Response shapes, mirroring the API's response schemas. The OpenAPI document
 * at /docs/json is the authoritative description.
 */

export type MonitorStatus = "PENDING" | "UP" | "DOWN";

export interface Envelope<T> {
  data: T;
}

export interface Page<T> {
  data: T[];
  meta: { nextCursor: string | null };
}

export interface User {
  id: string;
  email: string;
  createdAt: string;
}

export interface Monitor {
  id: string;
  name: string;
  url: string;
  method: "GET" | "HEAD";
  intervalSeconds: number;
  timeoutMs: number;
  failureThreshold: number;
  recoveryThreshold: number;
  paused: boolean;
  status: MonitorStatus;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardMonitor {
  id: string;
  name: string;
  url: string;
  status: MonitorStatus;
  paused: boolean;
  intervalSeconds: number;
  lastCheckedAt: string | null;
  checks24h: number;
  uptimePercent24h: number | null;
  avgResponseMs24h: number | null;
}

export interface Dashboard {
  counts: { total: number; up: number; down: number; pending: number; paused: number };
  openIncidents: number;
  last24h: { checks: number; uptimePercent: number | null; avgResponseMs: number | null };
  monitors: DashboardMonitor[];
}

export interface SeriesPoint {
  bucketStart: string;
  checks: number;
  successful: number;
  uptimePercent: number | null;
  avgResponseMs: number | null;
  p95ResponseMs: number | null;
}

export interface Analytics {
  range: "24h" | "7d" | "30d";
  from: string;
  to: string;
  checks: number;
  successful: number;
  failed: number;
  expectedChecks: number;
  uptimePercent: number | null;
  responseTimeMs: { avg: number | null; p50: number | null; p95: number | null };
  series: SeriesPoint[];
}

export interface Check {
  id: string;
  scheduledFor: string;
  checkedAt: string;
  success: boolean;
  statusCode: number | null;
  responseTimeMs: number | null;
  errorType: string | null;
  errorMessage: string | null;
}

export interface Incident {
  id: string;
  monitorId: string;
  monitorName: string;
  startedAt: string;
  resolvedAt: string | null;
  durationSeconds: number;
  cause: { errorType: string; statusCode: number | null; message: string | null };
}

export interface NotificationSettings {
  emailEnabled: boolean;
  notifyOnDown: boolean;
  notifyOnRecovery: boolean;
  email: string;
}
