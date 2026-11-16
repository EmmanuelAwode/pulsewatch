import { Link } from "react-router";
import type { DashboardMonitor, Incident } from "../api/types";
import {
  displayUrl,
  errorLabel,
  formatDateTime,
  formatDuration,
  formatMs,
  formatPercent,
  formatRelative,
} from "../lib/format";
import { cx, StatusBadge } from "./ui";

/** Monitors with their 24-hour figures. A table on wide screens, stacked rows on phones. */
export function MonitorTable({ monitors }: { monitors: DashboardMonitor[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-ink-2">
          <tr className="border-b border-line">
            <th className="px-4 py-2 font-medium">Monitor</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="hidden px-4 py-2 text-right font-medium sm:table-cell">Uptime 24h</th>
            <th className="hidden px-4 py-2 text-right font-medium sm:table-cell">Avg response</th>
            <th className="hidden px-4 py-2 text-right font-medium md:table-cell">Last check</th>
          </tr>
        </thead>
        <tbody>
          {monitors.map((monitor) => (
            <tr key={monitor.id} className="border-b border-line last:border-0 hover:bg-surface-2">
              <td className="max-w-0 px-4 py-3">
                <Link
                  to={`/monitors/${monitor.id}`}
                  className="block min-w-0 font-medium hover:underline"
                >
                  <span className="block truncate">{monitor.name}</span>
                  <span className="block truncate text-xs font-normal text-muted">
                    {displayUrl(monitor.url)}
                  </span>
                </Link>
              </td>
              <td className="px-4 py-3 whitespace-nowrap">
                <StatusBadge status={monitor.status} paused={monitor.paused} />
              </td>
              <td className="tabular hidden px-4 py-3 text-right sm:table-cell">
                {formatPercent(monitor.uptimePercent24h)}
              </td>
              <td className="tabular hidden px-4 py-3 text-right sm:table-cell">
                {formatMs(monitor.avgResponseMs24h)}
              </td>
              <td
                className="hidden px-4 py-3 text-right whitespace-nowrap text-ink-2 md:table-cell"
                title={monitor.lastCheckedAt ? formatDateTime(monitor.lastCheckedAt) : undefined}
              >
                {formatRelative(monitor.lastCheckedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function IncidentList({
  incidents,
  showMonitor = true,
}: {
  incidents: Incident[];
  showMonitor?: boolean;
}) {
  return (
    <ul>
      {incidents.map((incident) => {
        const open = incident.resolvedAt === null;
        return (
          <li
            key={incident.id}
            className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 border-b border-line px-4 py-3 text-sm last:border-0"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span
                  className={cx(
                    "rounded px-1.5 py-0.5 text-xs font-medium",
                    open ? "bg-critical text-white" : "bg-surface-2 text-ink-2",
                  )}
                >
                  {open ? "Ongoing" : "Resolved"}
                </span>
                {showMonitor ? (
                  <Link
                    to={`/monitors/${incident.monitorId}`}
                    className="truncate font-medium hover:underline"
                  >
                    {incident.monitorName}
                  </Link>
                ) : (
                  <span className="font-medium">
                    {errorLabel(incident.cause.errorType, incident.cause.statusCode)}
                  </span>
                )}
              </div>
              <p className="mt-1 truncate text-xs text-ink-2">
                {showMonitor &&
                  `${errorLabel(incident.cause.errorType, incident.cause.statusCode)} · `}
                {incident.cause.message ?? "No details"}
              </p>
            </div>
            <div className="tabular text-right text-xs text-ink-2">
              <div title={incident.startedAt}>{formatDateTime(incident.startedAt)}</div>
              <div className={cx("mt-0.5", open ? "font-medium text-critical-text" : "text-muted")}>
                {open
                  ? `Down for ${formatDuration(incident.durationSeconds)}`
                  : `Lasted ${formatDuration(incident.durationSeconds)}`}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
