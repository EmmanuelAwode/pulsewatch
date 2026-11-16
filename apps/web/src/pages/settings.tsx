import { useEffect, useState, type SyntheticEvent } from "react";
import { useNavigate } from "react-router";
import { describeError } from "../api/client";
import { useLogout, useMe, useSaveSettings, useSettings } from "../api/hooks";
import type { NotificationSettings } from "../api/types";
import { Button, ErrorState, FormError, PageHeader, Panel, Skeleton } from "../components/ui";
import { formatDateTime } from "../lib/format";

type Preferences = Omit<NotificationSettings, "email">;

function Toggle({
  label,
  description,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 py-3 has-disabled:cursor-not-allowed has-disabled:opacity-50">
      <input
        type="checkbox"
        className="mt-0.5 size-4 accent-[var(--ink)]"
        checked={checked}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-sm text-ink-2">{description}</span>
      </span>
    </label>
  );
}

function NotificationForm({ settings }: { settings: NotificationSettings }) {
  const save = useSaveSettings();
  const [values, setValues] = useState<Preferences>(settings);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setValues(settings);
  }, [settings]);

  const dirty =
    values.emailEnabled !== settings.emailEnabled ||
    values.notifyOnDown !== settings.notifyOnDown ||
    values.notifyOnRecovery !== settings.notifyOnRecovery;

  function update(patch: Partial<Preferences>) {
    setSaved(false);
    setValues((current) => ({ ...current, ...patch }));
  }

  function handleSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    save.mutate(values, {
      onSuccess: () => {
        setSaved(true);
      },
      onError: (failure) => {
        setError(describeError(failure));
      },
    });
  }

  return (
    <form onSubmit={handleSubmit} className="px-4 pb-4">
      <FormError message={error} />
      <div className="divide-y divide-line">
        <Toggle
          label="Email alerts"
          description={`Sent to ${settings.email}, your account email.`}
          checked={values.emailEnabled}
          onChange={(checked) => {
            update({ emailEnabled: checked });
          }}
        />
        <Toggle
          label="When a monitor goes down"
          description="One email when an incident opens."
          checked={values.notifyOnDown}
          disabled={!values.emailEnabled}
          onChange={(checked) => {
            update({ notifyOnDown: checked });
          }}
        />
        <Toggle
          label="When it recovers"
          description="One email when the incident resolves, with its duration."
          checked={values.notifyOnRecovery}
          disabled={!values.emailEnabled}
          onChange={(checked) => {
            update({ notifyOnRecovery: checked });
          }}
        />
      </div>
      <div className="mt-2 flex items-center justify-end gap-3">
        {saved && !dirty && <span className="text-sm text-good-text">Saved</span>}
        <Button type="submit" variant="primary" disabled={!dirty || save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

export function SettingsPage() {
  const me = useMe();
  const settings = useSettings();
  const logout = useLogout();
  const navigate = useNavigate();

  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid max-w-2xl gap-6">
        <Panel title="Notifications">
          {settings.isPending ? (
            <Skeleton rows={3} />
          ) : settings.isError ? (
            <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />
          ) : (
            <NotificationForm settings={settings.data} />
          )}
        </Panel>

        <Panel title="Account">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 p-4 text-sm">
            <dt className="text-ink-2">Email</dt>
            <dd className="truncate">{me.data?.email}</dd>
            <dt className="text-ink-2">Member since</dt>
            <dd>{me.data ? formatDateTime(me.data.createdAt) : "…"}</dd>
          </dl>
          <div className="flex justify-end border-t border-line p-4">
            <Button
              onClick={() => {
                logout.mutate(undefined, {
                  onSettled: () => {
                    void navigate("/login", { replace: true });
                  },
                });
              }}
              disabled={logout.isPending}
            >
              Log out
            </Button>
          </div>
        </Panel>
      </div>
    </>
  );
}
