export class ApiError extends Error {
  constructor(public status: number) {
    super(status === 401 ? "Sign in required" : "Information unavailable");
  }
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    ...options,
    signal: options.signal ?? AbortSignal.timeout(12000),
    headers: { Accept: "application/json", ...options.headers },
  });
  if (!response.ok) throw new ApiError(response.status);
  return response.json() as Promise<T>;
}
