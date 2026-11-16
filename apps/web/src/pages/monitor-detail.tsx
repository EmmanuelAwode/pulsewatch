import type { AnalyticsRange } from "@pulsewatch/shared";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ApiError } from "../api/client";
import {
  allItems,
  useAnalytics,
  useChecks,
  useDeleteMonitor,
  useMonitor,
  useMonitorIncidents,
  useUpdateMonitor,
} from "../api/hooks";
import type { Check, Monitor } from "../api/types";
import { LatencyChart, UptimeStrip } from "../components/charts";
import { IncidentList } from "../components/lists";
import { MonitorForm } from "../components/monitor-form";
import {
  Button,
  cx,
  EmptyState,
  ErrorState,
  FormError,
  LoadMore,
  PageHeader,
  Panel,
  Segmented,
  Skeleton,
  StatTile,
  StatusBadge,
} from "../components/ui";
import {
  displayUrl,
  errorLabel,
  formatDateTime,
  formatInterval,
  formatMs,
  formatPercent,
  formatRelative,
} from "../lib/format";

const RANGES: { value: AnalyticsRange; label: string }[] = [
  { value: "24h", label: "24 hours" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
];

export function MonitorDetailPage() {
  const { id = "" } = useParams();
  const monitor = useMonitor(id);

  if (monitor.isPending) {
    return <Skeleton rows={6} />;
  }
  if (monitor.isError) {
    if (monitor.error instanceof ApiError && monitor.error.status === 404) {
      return (
        <Panel>
          <EmptyState
            title="Monitor not found"
            body="It may have been deleted."
            action={
              <Link to="/monitors" className="text-sm font-medium hover:underline">
                Back to monitors
              </Link>
            }
          />
        </Panel>
      );
    }
    return (
      <Panel>
        <ErrorState error={monitor.error} onRetry={() => void monitor.refetch()} />
      </Panel>
    );
  }
  return <MonitorView monitor={monitor.data} />;
}

function MonitorView({ monitor }: { monitor: Monitor }) {
  const [range, setRange] = useState<AnalyticsRange>("24h");
  const [editing, setEditing] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const update = useUpdateMonitor(monitor.id);
  const remove = useDeleteMonitor();
  const navigate = useNavigate();
  const analytics = useAnalytics(monitor.id, range);

  function togglePause() {
    setActionError(undefined);
    update.mutate(
      { paused: !monitor.paused },
      {
        onError: (error) => {
          setActionError(error.message);
        },
      },
    );
  }

  function deleteMonitor() {
    if (
      !window.confirm(`Delete "${monitor.name}" and all of its history? This cannot be undone.`)
    ) {
      return;
    }
    setActionError(undefined);
    remove.mutate(monitor.id, {
      onSuccess: () => {
        void navigate("/monitors", { replace: true });
      },
      onError: (error) => {
        setActionError(error.message);
      },
    });
  }

  const stats = analytics.data;
  const coverage =
    stats && stats.expectedChecks > 0 && stats.checks < stats.expectedChecks * 0.9
      ? `${stats.checks.toLocaleString("en-GB")} of ${stats.expectedChecks.toLocaleString("en-GB")} expected checks`
      : stats
        ? `${stats.checks.toLocaleString("en-GB")} checks`
        : undefined;

  return (
    <>
      <div className="mb-2 text-sm">
        <Link to="/monitors" className="text-ink-2 hover:text-ink">
          ← Monitors
        </Link>
      </div>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {monitor.name}
            <StatusBadge status={monitor.status} paused={monitor.paused} />
          </span>
        }
        description={
          <span className="flex flex-wrap gap-x-3 gap-y-1">
            <a
              href={monitor.url}
              target="_blank"
              rel="noreferrer noopener"
              className="hover:underline"
            >
              {displayUrl(monitor.url)}
            </a>
            <span className="text-muted">
              {monitor.method} · {formatInterval(monitor.intervalSeconds)} · last checked{" "}
              {formatRelative(monitor.lastCheckedAt)}
            </span>
          </span>
        }
        actions={
          <>
            <Button onClick={togglePause} disabled={update.isPending}>
              {monitor.paused ? "Resume" : "Pause"}
            </Button>
            <Button
              onClick={() => {
                setEditing((open) => !open);
              }}
            >
              Edit
            </Button>
            <Button variant="danger" onClick={deleteMonitor} disabled={remove.isPending}>
              Delete
            </Button>
          </>
        }
      />
      <FormError message={actionError} />

      {editing && (
        <Panel title="Edit monitor" className="mb-6">
          <div className="p-4">
            <MonitorForm
              initial={monitor}
              submitLabel="Save changes"
              onCancel={() => {
                setEditing(false);
              }}
              onSubmit={async (values) => {
                await update.mutateAsync(values);
                setEditing(false);
              }}
            />
            {/* Changing the URL starts the monitor afresh: its open incident is closed. */}
            <p className="mt-3 text-xs text-muted">
              Changing the URL resets the status to Pending and closes any open incident.
            </p>
          </div>
        </Panel>
      )}

      <div className="mb-4 flex justify-end">
        <Segmented label="Time range" value={range} options={RANGES} onChange={setRange} />
      </div>

      {analytics.isError ? (
        <Panel className="mb-6">
          <ErrorState error={analytics.error} onRetry={() => void analytics.refetch()} />
        </Panel>
      ) : (
        <>
          <div
            className={cx(
              "grid grid-cols-2 gap-3 lg:grid-cols-4",
              analytics.isFetching && "opacity-80",
            )}
          >
            <StatTile
              label="Uptime"
              value={stats ? formatPercent(stats.uptimePercent, 3) : "…"}
              hint={coverage}
            />
            <StatTile
              label="Average"
              value={stats ? formatMs(stats.responseTimeMs.avg) : "…"}
              hint="Successful checks"
            />
            <StatTile label="Median" value={stats ? formatMs(stats.responseTimeMs.p50) : "…"} />
            <StatTile
              label="p95"
              value={stats ? formatMs(stats.responseTimeMs.p95) : "…"}
              hint="95% of checks were faster"
            />
          </div>

          <div className="mt-6 grid gap-6">
            <Panel title="Response time">
              <div className="p-4">
                {stats ? (
                  <LatencyChart series={stats.series} range={range} />
                ) : (
                  <Skeleton rows={5} />
                )}
              </div>
            </Panel>
            <Panel title="Availability">
              <div className="p-4">
                {stats ? (
                  <UptimeStrip series={stats.series} range={range} />
                ) : (
                  <Skeleton rows={1} />
                )}
              </div>
            </Panel>
          </div>
        </>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <ChecksPanel monitorId={monitor.id} />
        <IncidentsPanel monitorId={monitor.id} />
      </div>
    </>
  );
}

function CheckRow({ check }: { check: Check }) {
  return (
    <tr className="border-b border-line last:border-0">
      <td className="px-4 py-2 whitespace-nowrap text-ink-2" title={check.scheduledFor}>
        {formatDateTime(check.checkedAt)}
      </td>
      <td className="px-4 py-2 whitespace-nowrap">
        <span
          className={cx(
            "inline-flex items-center gap-1.5 font-medium",
            check.success ? "text-good-text" : "text-critical-text",
          )}
        >
          <span
            aria-hidden
            className={cx(
              "size-1.5",
              check.success ? "rounded-full bg-good" : "rotate-45 bg-critical",
            )}
          />
          {check.success ? "OK" : "Failed"}
        </span>
      </td>
      <td className="tabular px-4 py-2 text-right whitespace-nowrap">
        {formatMs(check.responseTimeMs)}
      </td>
      <td className="max-w-0 truncate px-4 py-2 text-ink-2" title={check.errorMessage ?? undefined}>
        {check.success
          ? `HTTP ${String(check.statusCode)}`
          : errorLabel(check.errorType, check.statusCode)}
      </td>
    </tr>
  );
}

function ChecksPanel({ monitorId }: { monitorId: string }) {
  const checks = useChecks(monitorId);
  const items = allItems(checks.data);
  return (
    <Panel title="Recent checks">
      {checks.isPending ? (
        <Skeleton rows={5} />
      ) : checks.isError ? (
        <ErrorState error={checks.error} onRetry={() => void checks.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          title="No checks yet"
          body="The first check runs within one interval of creating the monitor."
        />
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full table-fixed text-left text-sm">
              <thead className="text-xs text-ink-2">
                <tr className="border-b border-line">
                  <th className="w-40 px-4 py-2 font-medium">Time</th>
                  <th className="w-24 px-4 py-2 font-medium">Result</th>
                  <th className="w-24 px-4 py-2 text-right font-medium">Response</th>
                  <th className="px-4 py-2 font-medium">Detail</th>
                </tr>
              </thead>
              <tbody>
                {items.map((check) => (
                  <CheckRow key={check.id} check={check} />
                ))}
              </tbody>
            </table>
          </div>
          <LoadMore
            hasMore={checks.hasNextPage}
            loading={checks.isFetchingNextPage}
            onClick={() => void checks.fetchNextPage()}
          />
        </>
      )}
    </Panel>
  );
}

function IncidentsPanel({ monitorId }: { monitorId: string }) {
  const incidents = useMonitorIncidents(monitorId);
  const items = allItems(incidents.data);
  return (
    <Panel title="Incidents">
      {incidents.isPending ? (
        <Skeleton rows={3} />
      ) : incidents.isError ? (
        <ErrorState error={incidents.error} onRetry={() => void incidents.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          title="No incidents"
          body="An incident opens after 3 consecutive failed checks and closes after 2 successful ones."
        />
      ) : (
        <>
          <IncidentList incidents={items} showMonitor={false} />
          <LoadMore
            hasMore={incidents.hasNextPage}
            loading={incidents.isFetchingNextPage}
            onClick={() => void incidents.fetchNextPage()}
          />
        </>
      )}
    </Panel>
  );
}
