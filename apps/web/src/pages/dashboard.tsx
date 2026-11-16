import { Link } from "react-router";
import { allItems, useDashboard, useIncidents } from "../api/hooks";
import { IncidentList, MonitorTable } from "../components/lists";
import { EmptyState, ErrorState, PageHeader, Panel, Skeleton, StatTile } from "../components/ui";
import { formatMs, formatPercent } from "../lib/format";

export function DashboardPage() {
  const dashboard = useDashboard();
  const incidents = useIncidents("all", 5);

  if (dashboard.isPending) {
    return (
      <>
        <PageHeader title="Overview" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((key) => (
            <div
              key={key}
              className="h-[86px] animate-pulse rounded-lg border border-line bg-surface"
            />
          ))}
        </div>
      </>
    );
  }
  if (dashboard.isError) {
    return (
      <Panel>
        <ErrorState error={dashboard.error} onRetry={() => void dashboard.refetch()} />
      </Panel>
    );
  }

  const { counts, openIncidents, last24h, monitors } = dashboard.data;
  const addMonitor = (
    <Link
      to="/monitors?new=1"
      className="inline-flex h-9 items-center rounded-md bg-ink px-3 text-sm font-medium text-page hover:opacity-90"
    >
      Add monitor
    </Link>
  );

  if (counts.total === 0) {
    return (
      <>
        <PageHeader title="Overview" />
        <Panel>
          <EmptyState
            title="No monitors yet"
            body="Add an HTTPS endpoint and PulseWatch will check it on a schedule, record response times and open an incident if it goes down."
            action={addMonitor}
          />
        </Panel>
      </>
    );
  }

  const active = counts.total - counts.paused;
  return (
    <>
      <PageHeader
        title="Overview"
        description="All monitors, last 24 hours."
        actions={addMonitor}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Monitors up"
          value={`${String(counts.up)} / ${String(active)}`}
          hint={
            [
              counts.down > 0 && `${String(counts.down)} down`,
              counts.pending > 0 && `${String(counts.pending)} pending`,
              counts.paused > 0 && `${String(counts.paused)} paused`,
            ]
              .filter(Boolean)
              .join(" · ") || "All active monitors up"
          }
          tone={counts.down > 0 ? "critical" : undefined}
        />
        <StatTile
          label="Open incidents"
          value={openIncidents}
          tone={openIncidents > 0 ? "critical" : undefined}
          hint={openIncidents > 0 ? "Needs attention" : "None"}
        />
        <StatTile
          label="Uptime"
          value={formatPercent(last24h.uptimePercent)}
          hint={`${last24h.checks.toLocaleString("en-GB")} checks`}
        />
        <StatTile
          label="Avg response"
          value={formatMs(last24h.avgResponseMs)}
          hint="Successful checks"
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Panel
          title="Monitors"
          className="lg:col-span-2"
          actions={
            <Link to="/monitors" className="text-xs text-ink-2 hover:text-ink">
              Manage
            </Link>
          }
        >
          <MonitorTable monitors={monitors} />
        </Panel>
        <Panel
          title="Recent incidents"
          actions={
            <Link to="/incidents" className="text-xs text-ink-2 hover:text-ink">
              View all
            </Link>
          }
        >
          {incidents.isPending ? (
            <Skeleton />
          ) : incidents.isError ? (
            <ErrorState error={incidents.error} onRetry={() => void incidents.refetch()} />
          ) : allItems(incidents.data).length === 0 ? (
            <EmptyState
              title="No incidents"
              body="Outages will appear here when a monitor goes down."
            />
          ) : (
            <IncidentList incidents={allItems(incidents.data).slice(0, 5)} />
          )}
        </Panel>
      </div>
    </>
  );
}
