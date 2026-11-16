import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from "react";
import { useId } from "react";
import type { MonitorStatus } from "../api/types";
import { describeError } from "../api/client";

/** Joins class names, skipping falsy ones. */
export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary: "bg-ink text-page hover:opacity-90",
  secondary: "border border-line bg-surface text-ink hover:bg-surface-2",
  danger: "border border-line bg-surface text-critical-text hover:bg-surface-2",
  ghost: "text-ink-2 hover:bg-surface-2 hover:text-ink",
};

export function Button({
  variant = "secondary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      type="button"
      className={cx(
        "inline-flex h-9 items-center justify-center gap-2 rounded-md px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        BUTTON_STYLES[variant],
        className,
      )}
      {...props}
    />
  );
}

const STATUS: Record<
  MonitorStatus | "PAUSED",
  { label: string; dot: string; text: string; shape: string }
> = {
  UP: { label: "Up", dot: "bg-good", text: "text-good-text", shape: "rounded-full" },
  // A different shape as well as a different colour, so status never relies on colour alone.
  DOWN: {
    label: "Down",
    dot: "bg-critical",
    text: "text-critical-text",
    shape: "rotate-45 rounded-[1px]",
  },
  PENDING: {
    label: "Pending",
    dot: "border border-muted",
    text: "text-ink-2",
    shape: "rounded-full",
  },
  PAUSED: { label: "Paused", dot: "bg-muted", text: "text-ink-2", shape: "rounded-[1px]" },
};

export function StatusBadge({
  status,
  paused = false,
}: {
  status: MonitorStatus;
  paused?: boolean;
}) {
  const style = STATUS[paused ? "PAUSED" : status];
  return (
    <span className={cx("inline-flex items-center gap-1.5 text-sm font-medium", style.text)}>
      <span aria-hidden className={cx("size-2", style.dot, style.shape)} />
      {style.label}
    </span>
  );
}

export function StatTile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "critical" | "good" | undefined;
}) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <div className="text-xs font-medium tracking-wide text-ink-2 uppercase">{label}</div>
      <div
        className={cx(
          "tabular mt-1 text-2xl font-semibold tracking-tight",
          tone === "critical" && "text-critical-text",
          tone === "good" && "text-good-text",
        )}
      >
        {value}
      </div>
      {hint !== undefined && <div className="tabular mt-0.5 text-xs text-muted">{hint}</div>}
    </div>
  );
}

export function Panel({
  title,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx("rounded-lg border border-line bg-surface", className)}>
      {(title !== undefined || actions !== undefined) && (
        <header className="flex min-h-12 flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2">
          <h2 className="text-sm font-semibold">{title}</h2>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
        {description !== undefined && <p className="mt-1 text-sm text-ink-2">{description}</p>}
      </div>
      {actions !== undefined && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <p className="text-sm font-medium">{title}</p>
      {body !== undefined && <p className="mt-1 max-w-sm text-sm text-ink-2">{body}</p>}
      {action !== undefined && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center px-6 py-10 text-center">
      <p className="text-sm font-medium text-critical-text">Could not load this</p>
      <p className="mt-1 max-w-sm text-sm text-ink-2">{describeError(error)}</p>
      {onRetry && (
        <Button className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

/** Placeholder rows while data loads. Shaped like the content, so nothing jumps. */
export function Skeleton({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cx("space-y-3 p-4", className)} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="h-4 animate-pulse rounded bg-surface-2"
          style={{ width: `${90 - index * 12}%` }}
        />
      ))}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex rounded-md border border-line bg-surface p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => {
            onChange(option.value);
          }}
          className={cx(
            "h-7 rounded px-3 text-sm font-medium transition-colors",
            option.value === value ? "bg-surface-2 text-ink" : "text-ink-2 hover:text-ink",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string | undefined;
  hint?: ReactNode;
  children: (props: {
    id: string;
    "aria-invalid": boolean;
    "aria-describedby"?: string;
  }) => ReactNode;
}) {
  const id = useId();
  const messageId = `${id}-message`;
  const hasMessage = error !== undefined || hint !== undefined;
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      {children({
        id,
        "aria-invalid": error !== undefined,
        ...(hasMessage ? { "aria-describedby": messageId } : {}),
      })}
      {error !== undefined ? (
        <p id={messageId} className="mt-1 text-xs text-critical-text">
          {error}
        </p>
      ) : (
        hint !== undefined && (
          <p id={messageId} className="mt-1 text-xs text-muted">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

const CONTROL =
  "h-9 w-full rounded-md border border-line bg-page px-3 text-sm text-ink placeholder:text-muted aria-[invalid=true]:border-critical";

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(CONTROL, props.className)} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cx(CONTROL, "pr-8", props.className)} />;
}

export function FormError({ message }: { message: string | undefined }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-critical-text"
    >
      {message}
    </p>
  );
}

export function LoadMore({
  hasMore,
  loading,
  onClick,
}: {
  hasMore: boolean;
  loading: boolean;
  onClick: () => void;
}) {
  if (!hasMore) return null;
  return (
    <div className="border-t border-line p-3 text-center">
      <Button variant="ghost" onClick={onClick} disabled={loading}>
        {loading ? "Loading…" : "Load more"}
      </Button>
    </div>
  );
}
