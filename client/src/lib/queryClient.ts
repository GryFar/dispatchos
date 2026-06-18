import { QueryClient, QueryFunction } from "@tanstack/react-query";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function parseErrorBody(res: Response): Promise<{ message: string; body: unknown }> {
  const text = await res.text();
  if (!text) return { message: res.statusText || `HTTP ${res.status}`, body: null };
  try {
    const parsed = JSON.parse(text);
    const msg = (parsed && typeof parsed === "object" && "message" in parsed && typeof parsed.message === "string")
      ? parsed.message
      : res.statusText || `HTTP ${res.status}`;
    return { message: msg, body: parsed };
  } catch {
    return { message: text, body: text };
  }
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const { message, body } = await parseErrorBody(res);
    throw new ApiError(res.status, message, body);
  }
}

/** Legacy helper kept for compatibility with v1.2.7 dashboard. Returns the raw Response. */
export async function apiRequest(
  method: string,
  url: string,
  data?: unknown,
): Promise<Response> {
  const res = await fetch(`${API_BASE}${url}`, {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });
  await throwIfResNotOk(res);
  return res;
}

/** Preferred helper. Returns parsed JSON, throws ApiError on non-2xx. */
export async function apiJson<T = unknown>(
  method: string,
  url: string,
  data?: unknown,
): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`, {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });
  await throwIfResNotOk(res);
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const url = queryKey.join("/");
    const res = await fetch(`${API_BASE}${url}`, { credentials: "include" });
    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }
    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
      retry: (failureCount, error) => {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 404)) {
          return false;
        }
        return failureCount < 1;
      },
    },
    mutations: { retry: false },
  },
});
