import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { SeriesPoint } from "../api/types";
import { cx } from "./ui";
import { formatBucket, formatDateTime, formatMs, formatPercent, NO_DATA } from "../lib/format";

type Range = "24h" | "7d" | "30d";

const AXIS_TICK = { fill: "var(--muted)", fontSize: 12 };

type SeriesKey = "avgResponseMs" | "p95ResponseMs";

/**
 * A dot only where a point has no neighbour on either side. Lines are drawn
 * without markers, so an isolated measurement (data in one bucket, gaps
 * around it) would otherwise not be drawn at all, and real data would look
 * like no data. Found when a new monitor's chart appeared empty.
 */
function isolatedDot(series: SeriesPoint[], key: SeriesKey, color: string) {
  return function IsolatedDot(props: { cx?: number; cy?: number; index?: number }) {
    const { cx, cy, index } = props;
    if (cx === undefined || cy === undefined || index === undefined) return <g />;
    const before = series[index - 1]?.[key] ?? null;
    const after = series[index + 1]?.[key] ?? null;
    if (before !== null || after !== null) return <g key={index} />;
    return (
      <circle
        key={index}
        cx={cx}
        cy={cy}
        r={3}
        fill={color}
        stroke="var(--surface)"
        strokeWidth={1}
      />
    );
  };
}

interface TooltipProps {
  active?: boolean;
  payload?: readonly { payload?: SeriesPoint }[];
}

function LatencyTooltip({ active, payload }: TooltipProps) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  return (
    <div className="tabular rounded-md border border-line bg-surface px-3 py-2 text-xs shadow-sm">
      <div className="mb-1 font-medium text-ink">{formatDateTime(point.bucketStart)}</div>
      <div className="flex items-center gap-2 text-ink-2">
        <span className="h-0.5 w-3 bg-series-1" /> Average
        <span className="ml-auto text-ink">{formatMs(point.avgResponseMs)}</span>
      </div>
      <div className="flex items-center gap-2 text-ink-2">
        <span className="h-0.5 w-3 border-t-2 border-dashed border-series-2" /> p95
        <span className="ml-auto text-ink">{formatMs(point.p95ResponseMs)}</span>
      </div>
      <div className="mt-1 text-muted">
        {point.checks} checks · {formatPercent(point.uptimePercent)} up
      </div>
    </div>
  );
}

/**
 * Response time over the selected range: average and 95th percentile per
 * bucket, both in milliseconds on one axis. Successful checks only (a
 * timeout's "latency" is just the timeout setting).
 *
 * Empty buckets are gaps, not interpolated lines: joining across missing
 * data would suggest measurements that were never taken.
 */
export function LatencyChart({ series, range }: { series: SeriesPoint[]; range: Range }) {
  const hasData = series.some((point) => point.avgResponseMs !== null);

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-4 text-xs text-ink-2" aria-hidden>
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 bg-series-1" /> Average
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-4 border-t-2 border-dashed border-series-2" /> p95
        </span>
      </div>
      {hasData ? (
        <div className="h-56" role="img" aria-label="Response time chart. A data table follows.">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--grid)" />
              <XAxis
                dataKey="bucketStart"
                tickFormatter={(value: string) => formatBucket(value, range)}
                tick={AXIS_TICK}
                tickLine={false}
                axisLine={{ stroke: "var(--axis)" }}
                minTickGap={24}
              />
              <YAxis
                tickFormatter={(value: number) => `${String(value)} ms`}
                tick={AXIS_TICK}
                tickLine={false}
                axisLine={false}
                width={64}
              />
              <Tooltip
                content={(props) => <LatencyTooltip {...props} />}
                cursor={{ stroke: "var(--axis)", strokeWidth: 1 }}
              />
              <Line
                type="monotone"
                dataKey="avgResponseMs"
                name="Average"
                stroke="var(--series-1)"
                strokeWidth={2}
                dot={isolatedDot(series, "avgResponseMs", "var(--series-1)")}
                activeDot={{ r: 4, stroke: "var(--surface)", strokeWidth: 2 }}
                connectNulls={false}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="p95ResponseMs"
                name="p95"
                stroke="var(--series-2)"
                strokeWidth={2}
                strokeDasharray="5 4"
                dot={isolatedDot(series, "p95ResponseMs", "var(--series-2)")}
                activeDot={{ r: 4, stroke: "var(--surface)", strokeWidth: 2 }}
                connectNulls={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="flex h-56 items-center justify-center rounded-md bg-surface-2 text-sm text-ink-2">
          No successful checks in this period yet.
        </div>
      )}
      <SeriesTable series={series} range={range} />
    </div>
  );
}

function bucketTone(point: SeriesPoint): { className: string; label: string } {
  if (point.uptimePercent === null) return { className: "bg-nodata", label: "No data" };
  if (point.uptimePercent === 100) return { className: "bg-good", label: "Fully up" };
  if (point.uptimePercent >= 99) return { className: "bg-warning", label: "Degraded" };
  return { className: "bg-critical", label: "Outage" };
}

/**
 * Uptime per bucket as a strip of blocks, the way status pages show it.
 * Each block has a text tooltip and the strip has a legend, so the colour is
 * never the only carrier of meaning.
 */
export function UptimeStrip({ series, range }: { series: SeriesPoint[]; range: Range }) {
  return (
    <div>
      <div className="flex h-8 gap-[2px]" role="list" aria-label="Uptime per period">
        {series.map((point) => {
          const tone = bucketTone(point);
          const text = `${formatDateTime(point.bucketStart)}: ${
            point.uptimePercent === null ? "no data" : `${formatPercent(point.uptimePercent)} up`
          } (${tone.label})`;
          return (
            <div
              key={point.bucketStart}
              role="listitem"
              title={text}
              aria-label={text}
              className={cx("flex-1 rounded-sm first:rounded-l last:rounded-r", tone.className)}
            />
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span>{series[0] ? formatBucket(series[0].bucketStart, range) : NO_DATA}</span>
        <span className="flex flex-wrap gap-3">
          <Legend className="bg-good" label="100%" />
          <Legend className="bg-warning" label="≥ 99%" />
          <Legend className="bg-critical" label="< 99%" />
          <Legend className="bg-nodata" label="No data" />
        </span>
        <span>Now</span>
      </div>
    </div>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className={cx("size-2.5 rounded-sm", className)} aria-hidden /> {label}
    </span>
  );
}

/** The chart's data as a table, for screen readers and anyone who wants exact values. */
function SeriesTable({ series, range }: { series: SeriesPoint[]; range: Range }) {
  return (
    <details className="mt-3 text-sm">
      <summary className="cursor-pointer text-xs text-ink-2 select-none">Show data table</summary>
      <div className="mt-2 max-h-64 overflow-auto rounded-md border border-line">
        <table className="tabular w-full text-left text-xs">
          <thead className="sticky top-0 bg-surface-2 text-ink-2">
            <tr>
              <th className="px-3 py-2 font-medium">{range === "24h" ? "Hour" : "Period"}</th>
              <th className="px-3 py-2 font-medium">Checks</th>
              <th className="px-3 py-2 font-medium">Uptime</th>
              <th className="px-3 py-2 font-medium">Average</th>
              <th className="px-3 py-2 font-medium">p95</th>
            </tr>
          </thead>
          <tbody>
            {series.map((point) => (
              <tr key={point.bucketStart} className="border-t border-line">
                <td className="px-3 py-1.5">{formatDateTime(point.bucketStart)}</td>
                <td className="px-3 py-1.5">{point.checks}</td>
                <td className="px-3 py-1.5">{formatPercent(point.uptimePercent)}</td>
                <td className="px-3 py-1.5">{formatMs(point.avgResponseMs)}</td>
                <td className="px-3 py-1.5">{formatMs(point.p95ResponseMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
