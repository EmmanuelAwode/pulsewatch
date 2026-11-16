import { NavLink, Navigate, Outlet, useLocation, useNavigate } from "react-router";
import { useLogout, useMe } from "../api/hooks";
import { useLiveUpdates, type LiveState } from "../lib/live";
import { Button, cx, Skeleton } from "./ui";

const NAV = [
  { to: "/", label: "Overview", end: true },
  { to: "/monitors", label: "Monitors", end: false },
  { to: "/incidents", label: "Incidents", end: false },
  { to: "/settings", label: "Settings", end: false },
];

export function Logo() {
  return (
    <span className="flex items-center gap-2 font-semibold tracking-tight">
      <svg viewBox="0 0 32 32" className="size-6" aria-hidden>
        <rect width="32" height="32" rx="7" fill="var(--ink)" />
        <path
          d="M5 17h5l3-7 5 13 3-6h6"
          fill="none"
          stroke="#1baf7a"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      PulseWatch
    </span>
  );
}

const LIVE_LABEL: Record<LiveState, string> = {
  connecting: "Connecting",
  live: "Live",
  offline: "Reconnecting",
};

function LiveIndicator({ state }: { state: LiveState }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-ink-2" title="Live updates">
      <span
        aria-hidden
        className={cx(
          "size-1.5 rounded-full",
          state === "live" ? "bg-good" : state === "offline" ? "bg-warning" : "bg-muted",
        )}
      />
      {LIVE_LABEL[state]}
    </span>
  );
}

/** Redirects to the login page unless there is a session. */
export function RequireAuth() {
  const me = useMe();
  const location = useLocation();

  if (me.isPending) {
    return (
      <div className="mx-auto max-w-md pt-24">
        <Skeleton rows={3} />
      </div>
    );
  }
  if (me.isError) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <AppShell email={me.data.email} />;
}

function AppShell({ email }: { email: string }) {
  const live = useLiveUpdates();
  const logout = useLogout();
  const navigate = useNavigate();

  function signOut() {
    logout.mutate(undefined, {
      onSettled: () => {
        void navigate("/login", { replace: true });
      },
    });
  }

  const links = NAV.map((item) => (
    <NavLink
      key={item.to}
      to={item.to}
      end={item.end}
      className={({ isActive }) =>
        cx(
          "rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors",
          isActive ? "bg-surface-2 text-ink" : "text-ink-2 hover:text-ink",
        )
      }
    >
      {item.label}
    </NavLink>
  ));

  return (
    <div className="min-h-screen md:flex">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-line px-3 py-4 md:flex">
        <div className="px-3 pb-6">
          <Logo />
        </div>
        <nav className="flex flex-col gap-0.5" aria-label="Main">
          {links}
        </nav>
        <div className="mt-auto space-y-3 px-3">
          <LiveIndicator state={live} />
          <div className="truncate text-xs text-muted" title={email}>
            {email}
          </div>
          <Button
            variant="secondary"
            className="w-full"
            onClick={signOut}
            disabled={logout.isPending}
          >
            Log out
          </Button>
        </div>
      </aside>

      {/* Mobile header */}
      <header className="sticky top-0 z-10 border-b border-line bg-page/95 backdrop-blur md:hidden">
        <div className="flex items-center justify-between px-4 py-3">
          <Logo />
          <LiveIndicator state={live} />
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-2" aria-label="Main">
          {links}
        </nav>
      </header>

      <main className="mx-auto w-full max-w-6xl min-w-0 px-4 py-6 sm:px-8 sm:py-8">
        <Outlet />
      </main>
    </div>
  );
}
