import type { AnalyticsRange, CreateMonitorInput, UpdateMonitorInput } from "@pulsewatch/shared";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { api } from "./client";
import type {
  Analytics,
  Check,
  Dashboard,
  Envelope,
  Incident,
  Monitor,
  NotificationSettings,
  Page,
  User,
} from "./types";

/**
 * Query keys are hierarchical, so one invalidation can refresh everything
 * about a monitor: ["monitor", id] also matches ["monitor", id, "analytics", ...].
 */
export const keys = {
  me: ["me"] as const,
  dashboard: ["dashboard"] as const,
  monitor: (id: string) => ["monitor", id] as const,
  analytics: (id: string, range: AnalyticsRange) => ["monitor", id, "analytics", range] as const,
  checks: (id: string) => ["monitor", id, "checks"] as const,
  monitorIncidents: (id: string) => ["monitor", id, "incidents"] as const,
  incidents: (status: string) => ["incidents", status] as const,
  settings: ["settings"] as const,
};

/** Live updates drive freshness; this is only a safety net if events are missed. */
const FALLBACK_REFRESH_MS = 60_000;

export function useMe() {
  return useQuery({
    queryKey: keys.me,
    queryFn: async () => (await api.get<Envelope<{ user: User }>>("/auth/me")).data.user,
    retry: false,
    staleTime: 5 * 60_000,
  });
}

export function useDashboard() {
  return useQuery({
    queryKey: keys.dashboard,
    queryFn: async ({ signal }) => (await api.get<Envelope<Dashboard>>("/dashboard", signal)).data,
    refetchInterval: FALLBACK_REFRESH_MS,
  });
}

export function useMonitor(id: string) {
  return useQuery({
    queryKey: keys.monitor(id),
    queryFn: async ({ signal }) =>
      (await api.get<Envelope<Monitor>>(`/monitors/${id}`, signal)).data,
  });
}

export function useAnalytics(id: string, range: AnalyticsRange) {
  return useQuery({
    queryKey: keys.analytics(id, range),
    queryFn: async ({ signal }) =>
      (await api.get<Envelope<Analytics>>(`/monitors/${id}/analytics?range=${range}`, signal)).data,
    refetchInterval: FALLBACK_REFRESH_MS,
    placeholderData: (previous) => previous,
  });
}

function pageQuery<T>(path: (cursor: string | null) => string) {
  return async ({ pageParam, signal }: { pageParam: string | null; signal: AbortSignal }) =>
    api.get<Page<T>>(path(pageParam), signal);
}

const withCursor = (base: string, cursor: string | null) =>
  cursor ? `${base}${base.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}` : base;

export function useChecks(id: string) {
  return useInfiniteQuery({
    queryKey: keys.checks(id),
    queryFn: pageQuery<Check>((cursor) => withCursor(`/monitors/${id}/checks?limit=25`, cursor)),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.meta.nextCursor,
  });
}

export function useMonitorIncidents(id: string) {
  return useInfiniteQuery({
    queryKey: keys.monitorIncidents(id),
    queryFn: pageQuery<Incident>((cursor) =>
      withCursor(`/monitors/${id}/incidents?limit=10`, cursor),
    ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.meta.nextCursor,
  });
}

export function useIncidents(status: "all" | "open" | "resolved", limit = 25) {
  return useInfiniteQuery({
    queryKey: [...keys.incidents(status), limit],
    queryFn: pageQuery<Incident>((cursor) =>
      withCursor(`/incidents?status=${status}&limit=${limit}`, cursor),
    ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.meta.nextCursor,
  });
}

/** Flattens the pages of an infinite query into one list. */
export function allItems<T>(data: InfiniteData<Page<T>> | undefined): T[] {
  return data?.pages.flatMap((page) => page.data) ?? [];
}

export function useSettings() {
  return useQuery({
    queryKey: keys.settings,
    queryFn: async () =>
      (await api.get<Envelope<NotificationSettings>>("/settings/notifications")).data,
  });
}

// --- Mutations ----------------------------------------------------------------

export function useLogin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string }) =>
      api.post<Envelope<{ user: User }>>("/auth/login", input),
    onSuccess: (response) => {
      client.clear();
      client.setQueryData(keys.me, response.data.user);
    },
  });
}

export function useRegister() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string }) =>
      api.post<Envelope<{ user: User }>>("/auth/register", input),
    onSuccess: (response) => {
      client.clear();
      client.setQueryData(keys.me, response.data.user);
    },
  });
}

export function useLogout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<undefined>("/auth/logout"),
    onSettled: () => {
      // Nothing cached for this user may survive into the next session.
      client.clear();
    },
  });
}

export function useCreateMonitor() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMonitorInput) => api.post<Envelope<Monitor>>("/monitors", input),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.dashboard }),
  });
}

export function useUpdateMonitor(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: UpdateMonitorInput) =>
      api.patch<Envelope<Monitor>>(`/monitors/${id}`, patch),
    onSuccess: async (response) => {
      client.setQueryData(keys.monitor(id), response.data);
      await Promise.all([
        client.invalidateQueries({ queryKey: keys.monitor(id) }),
        client.invalidateQueries({ queryKey: keys.dashboard }),
      ]);
    },
  });
}

export function useDeleteMonitor() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/monitors/${id}`),
    onSuccess: async (_result, id) => {
      client.removeQueries({ queryKey: keys.monitor(id) });
      await Promise.all([
        client.invalidateQueries({ queryKey: keys.dashboard }),
        client.invalidateQueries({ queryKey: ["incidents"] }),
      ]);
    },
  });
}

export function useSaveSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<NotificationSettings, "email">) =>
      api.put<Envelope<NotificationSettings>>("/settings/notifications", input),
    onSuccess: (response) => {
      client.setQueryData(keys.settings, response.data);
    },
  });
}
