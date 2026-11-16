/** Placeholder for "no data", distinct from a real zero. */
export const NO_DATA = "—";

export function formatPercent(value: number | null, digits = 2): string {
  if (value === null) return NO_DATA;
  // 100 is shown as "100%", not "100.00%"; anything else keeps its precision
  // so that 99.99% never rounds up to look perfect.
  if (value === 100) return "100%";
  return `${value.toFixed(digits)}%`;
}

export function formatMs(value: number | null): string {
  if (value === null) return NO_DATA;
  if (value >= 10_000) return `${(value / 1000).toFixed(1)} s`;
  return `${Math.round(value).toLocaleString("en-GB")} ms`;
}

/** "45 s", "3 min", "2 h 5 min", "3 d 4 h". */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return hours > 0 ? `${days} d ${hours} h` : `${days} d`;
  if (hours > 0) return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
  if (minutes > 0) return `${minutes} min`;
  return `${seconds} s`;
}

/** "just now", "5 min ago", "3 h ago", "2 d ago". */
export function formatRelative(iso: string | null, now: Date = new Date()): string {
  if (iso === null) return "Never";
  const seconds = Math.round((now.getTime() - new Date(iso).getTime()) / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds} s ago`;
  return `${formatDuration(seconds)} ago`;
}

/** Local date and time, unambiguous across locales: "16 Nov 2026, 14:05". */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Axis label for a chart bucket: a time for 24 h, a date otherwise. */
export function formatBucket(iso: string, range: "24h" | "7d" | "30d"): string {
  const date = new Date(iso);
  if (range === "24h") {
    return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function formatInterval(seconds: number): string {
  if (seconds % 3_600 === 0) return seconds === 3_600 ? "Every hour" : `Every ${seconds / 3_600} h`;
  if (seconds % 60 === 0) return seconds === 60 ? "Every minute" : `Every ${seconds / 60} min`;
  return `Every ${seconds} s`;
}

/** The host and path of a URL without the scheme, for compact display. */
export function displayUrl(url: string): string {
  return url.replace(/^https:\/\//, "").replace(/\/$/, "");
}

const ERROR_LABELS: Record<string, string> = {
  TIMEOUT: "Timeout",
  DNS: "DNS failure",
  CONNECTION: "Connection failed",
  TLS: "TLS / certificate",
  BLOCKED_ADDRESS: "Blocked address",
  HTTP_STATUS: "HTTP error",
  RESPONSE_TOO_LARGE: "Response too large",
  UNKNOWN: "Unknown error",
};

export function errorLabel(type: string | null, statusCode: number | null = null): string {
  if (type === "HTTP_STATUS" && statusCode !== null) return `HTTP ${statusCode}`;
  return type ? (ERROR_LABELS[type] ?? type) : NO_DATA;
}
