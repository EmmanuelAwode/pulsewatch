import type { Email } from "./mailer.js";

export interface AlertDetails {
  event: "INCIDENT_OPENED" | "INCIDENT_RESOLVED";
  recipient: string;
  monitorName: string;
  monitorUrl: string;
  startedAt: Date;
  resolvedAt: Date | null;
  causeMessage: string | null;
}

/** "1 h 5 min", "3 min 20 s", "45 s". */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours} h ${minutes} min`;
  if (minutes > 0) return `${minutes} min ${seconds} s`;
  return `${seconds} s`;
}

/** Plain-text alert. Plain text needs no HTML escaping and renders everywhere. */
export function renderAlert(details: AlertDetails): Email {
  const started = details.startedAt.toISOString();

  if (details.event === "INCIDENT_OPENED") {
    return {
      to: details.recipient,
      subject: `[PulseWatch] DOWN: ${details.monitorName}`,
      text: [
        `${details.monitorName} is down.`,
        "",
        `URL:     ${details.monitorUrl}`,
        `Since:   ${started} (UTC)`,
        `Reason:  ${details.causeMessage ?? "Unknown"}`,
        "",
        "You will get one more email when it recovers.",
      ].join("\n"),
    };
  }

  const resolved = details.resolvedAt ?? details.startedAt;
  return {
    to: details.recipient,
    subject: `[PulseWatch] RECOVERED: ${details.monitorName}`,
    text: [
      `${details.monitorName} is back up.`,
      "",
      `URL:       ${details.monitorUrl}`,
      `Down from: ${started} (UTC)`,
      `Up at:     ${resolved.toISOString()} (UTC)`,
      `Duration:  ${formatDuration(resolved.getTime() - details.startedAt.getTime())}`,
    ].join("\n"),
  };
}
