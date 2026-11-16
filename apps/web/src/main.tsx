import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Link } from "react-router";
import { RouterProvider } from "react-router/dom";
import { ApiError, SessionExpiredError } from "./api/client";
import { RequireAuth } from "./components/layout";
import { EmptyState, Panel } from "./components/ui";
import "./index.css";
import { LoginPage, RegisterPage } from "./pages/auth";
import { DashboardPage } from "./pages/dashboard";
import { IncidentsPage } from "./pages/incidents";
import { MonitorsPage } from "./pages/monitors";
import { SettingsPage } from "./pages/settings";

/** A session that cannot be renewed ends on the login page, from wherever it expired. */
function onSessionError(error: unknown) {
  if (error instanceof SessionExpiredError && window.location.pathname !== "/login") {
    queryClient.clear();
    window.location.assign("/login");
  }
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: onSessionError }),
  mutationCache: new MutationCache({ onError: onSessionError }),
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      // Retry server and network failures, never client errors such as 404:
      // asking again will not make a missing monitor appear.
      retry: (failures, error) =>
        !(error instanceof SessionExpiredError) &&
        !(error instanceof ApiError && error.status < 500) &&
        failures < 2,
    },
  },
});

function NotFound() {
  return (
    <Panel>
      <EmptyState
        title="Page not found"
        action={
          <Link to="/" className="text-sm font-medium hover:underline">
            Go to the overview
          </Link>
        }
      />
    </Panel>
  );
}

const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  { path: "/register", element: <RegisterPage /> },
  {
    element: <RequireAuth />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: "monitors", element: <MonitorsPage /> },
      {
        path: "monitors/:id",
        // Loaded on demand: this is the only page with charts, and the chart
        // library is most of the bundle.
        lazy: async () => ({
          Component: (await import("./pages/monitor-detail")).MonitorDetailPage,
        }),
      },
      { path: "incidents", element: <IncidentsPage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
