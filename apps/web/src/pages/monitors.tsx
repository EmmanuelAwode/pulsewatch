import { MAX_MONITORS_PER_USER } from "@pulsewatch/shared";
import { useNavigate, useSearchParams } from "react-router";
import { useCreateMonitor, useDashboard } from "../api/hooks";
import { MonitorTable } from "../components/lists";
import { MonitorForm } from "../components/monitor-form";
import { Button, EmptyState, ErrorState, PageHeader, Panel, Skeleton } from "../components/ui";

export function MonitorsPage() {
  const dashboard = useDashboard();
  const create = useCreateMonitor();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const creating = params.get("new") === "1";

  function setCreating(open: boolean) {
    setParams(open ? { new: "1" } : {}, { replace: true });
  }

  const total = dashboard.data?.counts.total ?? 0;
  const atLimit = total >= MAX_MONITORS_PER_USER;

  return (
    <>
      <PageHeader
        title="Monitors"
        description={
          dashboard.data
            ? `${String(total)} of ${String(MAX_MONITORS_PER_USER)} monitors used.`
            : undefined
        }
        actions={
          !creating && (
            <Button
              variant="primary"
              onClick={() => {
                setCreating(true);
              }}
              disabled={atLimit}
              title={atLimit ? "You have reached the monitor limit." : undefined}
            >
              Add monitor
            </Button>
          )
        }
      />

      {creating && (
        <Panel title="New monitor" className="mb-6">
          <div className="p-4">
            <MonitorForm
              submitLabel="Create monitor"
              onCancel={() => {
                setCreating(false);
              }}
              onSubmit={async (values) => {
                const response = await create.mutateAsync(values);
                void navigate(`/monitors/${response.data.id}`);
              }}
            />
          </div>
        </Panel>
      )}

      <Panel>
        {dashboard.isPending ? (
          <Skeleton rows={4} />
        ) : dashboard.isError ? (
          <ErrorState error={dashboard.error} onRetry={() => void dashboard.refetch()} />
        ) : dashboard.data.monitors.length === 0 ? (
          <EmptyState
            title="No monitors yet"
            body="Each monitor checks one HTTPS endpoint on a schedule."
            action={
              !creating && (
                <Button
                  variant="primary"
                  onClick={() => {
                    setCreating(true);
                  }}
                >
                  Add your first monitor
                </Button>
              )
            }
          />
        ) : (
          <MonitorTable monitors={dashboard.data.monitors} />
        )}
      </Panel>
    </>
  );
}
