import type { ApiResult } from "./types";

export class ApiClientError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

/** 统一解析 { ok, data } 信封，并把 { ok:false, error } 转成异常。 */
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiClientError("无法连接本地服务，请确认应用正在运行", "NETWORK", 0);
  }

  let payload: ApiResult<T> | null = null;
  try {
    payload = (await response.json()) as ApiResult<T>;
  } catch {
    throw new ApiClientError("响应不是合法的 JSON", "PARSE", response.status);
  }

  if (!response.ok || !payload?.ok) {
    const err = payload && !payload.ok ? payload.error : null;
    throw new ApiClientError(
      err?.message || `请求失败（HTTP ${response.status}）`,
      err?.code || "UNKNOWN",
      response.status
    );
  }
  return payload.data;
}

export function apiJson<T>(path: string, method: "POST" | "PATCH", body: unknown): Promise<T> {
  return api<T>(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
