import { useState } from "react";
import { allItems, useIncidents } from "../api/hooks";
import { IncidentList } from "../components/lists";
import {
  EmptyState,
  ErrorState,
  LoadMore,
  PageHeader,
  Panel,
  Segmented,
  Skeleton,
} from "../components/ui";

type Filter = "all" | "open" | "resolved";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "open", label: "Ongoing" },
  { value: "resolved", label: "Resolved" },
];

export function IncidentsPage() {
  const [filter, setFilter] = useState<Filter>("all");
  const incidents = useIncidents(filter);
  const items = allItems(incidents.data);

  return (
    <>
      <PageHeader
        title="Incidents"
        description="An incident opens after a monitor's failure threshold is reached and resolves after its recovery threshold."
        actions={
          <Segmented
            label="Filter incidents"
            value={filter}
            options={FILTERS}
            onChange={setFilter}
          />
        }
      />
      <Panel>
        {incidents.isPending ? (
          <Skeleton rows={5} />
        ) : incidents.isError ? (
          <ErrorState error={incidents.error} onRetry={() => void incidents.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            title={filter === "open" ? "Nothing is down" : "No incidents"}
            body={
              filter === "open"
                ? "Every monitor is passing its checks."
                : "Outages will be recorded here."
            }
          />
        ) : (
          <>
            <IncidentList incidents={items} />
            <LoadMore
              hasMore={incidents.hasNextPage}
              loading={incidents.isFetchingNextPage}
              onClick={() => void incidents.fetchNextPage()}
            />
          </>
        )}
      </Panel>
    </>
  );
}
