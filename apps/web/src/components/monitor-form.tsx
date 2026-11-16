import { createMonitorSchema, type CreateMonitorInput } from "@pulsewatch/shared";
import { useState, type SyntheticEvent } from "react";
import { ApiError, describeError } from "../api/client";
import { Button, Field, FormError, Input, Select } from "./ui";

const INTERVALS = [
  { value: 60, label: "Every minute" },
  { value: 300, label: "Every 5 minutes" },
  { value: 600, label: "Every 10 minutes" },
  { value: 1_800, label: "Every 30 minutes" },
  { value: 3_600, label: "Every hour" },
];

const TIMEOUTS = [
  { value: 5_000, label: "5 seconds" },
  { value: 10_000, label: "10 seconds" },
  { value: 20_000, label: "20 seconds" },
  { value: 30_000, label: "30 seconds" },
];

type Values = Pick<
  CreateMonitorInput,
  | "name"
  | "url"
  | "method"
  | "intervalSeconds"
  | "timeoutMs"
  | "failureThreshold"
  | "recoveryThreshold"
>;

const DEFAULTS: Values = {
  name: "",
  url: "https://",
  method: "GET",
  intervalSeconds: 60,
  timeoutMs: 10_000,
  failureThreshold: 3,
  recoveryThreshold: 2,
};

/** Keeps a saved value selectable even if it is not one of the presets. */
function withCurrent(options: { value: number; label: string }[], current: number, unit: string) {
  return options.some((option) => option.value === current)
    ? options
    : [...options, { value: current, label: `${String(current)} ${unit}` }];
}

/**
 * Create or edit a monitor. Validation uses the same Zod schema as the API,
 * so the browser rejects exactly what the server would, and the server's own
 * field errors are shown in the same places if it disagrees.
 */
export function MonitorForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: Values;
  submitLabel: string;
  onSubmit: (values: CreateMonitorInput) => Promise<unknown>;
  onCancel?: () => void;
}) {
  const [values, setValues] = useState<Values>(initial ?? DEFAULTS);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  function set<K extends keyof Values>(key: K, value: Values[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function handleSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(undefined);
    const parsed = createMonitorSchema.safeParse(values);
    if (!parsed.success) {
      setErrors(
        Object.fromEntries(
          parsed.error.issues.map((issue) => [String(issue.path[0]), issue.message]),
        ),
      );
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      await onSubmit(parsed.data);
    } catch (error) {
      if (error instanceof ApiError && error.details.length > 0) {
        setErrors(Object.fromEntries(error.details.map((detail) => [detail.path, detail.message])));
      }
      setFormError(describeError(error));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} noValidate className="space-y-4">
      <FormError message={formError} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" error={errors["name"]}>
          {(props) => (
            <Input
              {...props}
              value={values.name}
              placeholder="Checkout API"
              maxLength={100}
              onChange={(event) => {
                set("name", event.target.value);
              }}
            />
          )}
        </Field>
        <Field
          label="URL"
          error={errors["url"]}
          hint="HTTPS only. Redirects are not followed, so enter the final URL."
        >
          {(props) => (
            <Input
              {...props}
              type="url"
              inputMode="url"
              value={values.url}
              placeholder="https://api.example.com/health"
              onChange={(event) => {
                set("url", event.target.value);
              }}
            />
          )}
        </Field>
        <Field label="Check frequency" error={errors["intervalSeconds"]}>
          {(props) => (
            <Select
              {...props}
              value={values.intervalSeconds}
              onChange={(event) => {
                set("intervalSeconds", Number(event.target.value));
              }}
            >
              {withCurrent(INTERVALS, values.intervalSeconds, "seconds").map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Timeout" error={errors["timeoutMs"]}>
          {(props) => (
            <Select
              {...props}
              value={values.timeoutMs}
              onChange={(event) => {
                set("timeoutMs", Number(event.target.value));
              }}
            >
              {withCurrent(TIMEOUTS, values.timeoutMs, "ms").map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      <details className="rounded-md border border-line px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium select-none">Advanced</summary>
        <div className="mt-3 grid gap-4 pb-1 sm:grid-cols-3">
          <Field label="Method" error={errors["method"]}>
            {(props) => (
              <Select
                {...props}
                value={values.method}
                onChange={(event) => {
                  set("method", event.target.value === "HEAD" ? "HEAD" : "GET");
                }}
              >
                <option value="GET">GET</option>
                <option value="HEAD">HEAD</option>
              </Select>
            )}
          </Field>
          <Field
            label="Failures before down"
            error={errors["failureThreshold"]}
            hint="Consecutive failed checks."
          >
            {(props) => (
              <Input
                {...props}
                type="number"
                min={1}
                max={10}
                value={values.failureThreshold}
                onChange={(event) => {
                  set("failureThreshold", Number(event.target.value));
                }}
              />
            )}
          </Field>
          <Field
            label="Successes before up"
            error={errors["recoveryThreshold"]}
            hint="Consecutive passing checks."
          >
            {(props) => (
              <Input
                {...props}
                type="number"
                min={1}
                max={10}
                value={values.recoveryThreshold}
                onChange={(event) => {
                  set("recoveryThreshold", Number(event.target.value));
                }}
              />
            )}
          </Field>
        </div>
      </details>

      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" variant="primary" disabled={submitting}>
          {submitting ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
