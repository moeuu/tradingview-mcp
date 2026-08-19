const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

export class TradingViewDataClient {
  constructor(
    private readonly apiKey: string | undefined,
    private readonly host: string,
  ) {}

  get configured(): boolean {
    return Boolean(this.apiKey);
  }

  async get(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
    options: { signal?: AbortSignal } = {},
  ) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) search.set(key, String(value));
    }
    const suffix = search.size > 0 ? `?${search.toString()}` : "";
    return this.#request(`${path}${suffix}`, {
      method: "GET",
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  async post(path: string, body: unknown, options: { signal?: AbortSignal } = {}) {
    return this.#request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }

  async #request(path: string, init: RequestInit): Promise<unknown> {
    if (!this.apiKey) {
      throw new UpstreamError(
        "Live upstream is not configured. Set TRADINGVIEW_RAPIDAPI_KEY (or RAPIDAPI_KEY).",
      );
    }
    if (!path.startsWith("/") || path.startsWith("//")) {
      throw new Error("Upstream request path must be absolute and host-relative.");
    }
    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    const response = await fetch(`https://${this.host}${path}`, {
      ...init,
      signal,
      headers: {
        ...init.headers,
        "x-rapidapi-host": this.host,
        "x-rapidapi-key": this.apiKey,
      },
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new UpstreamError(`TradingView Data API request failed: ${message}`);
    });

    const declaredSize = Number(response.headers.get("content-length") ?? "0");
    if (declaredSize > MAX_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw new UpstreamError("TradingView Data API response exceeded the size limit.", response.status);
    }
    const text = await readBoundedText(response, MAX_RESPONSE_BYTES);
    let payload: unknown;
    try {
      payload = text === "" ? null : JSON.parse(text);
    } catch {
      throw new UpstreamError(
        `TradingView Data API returned invalid JSON (HTTP ${response.status}).`,
        response.status,
      );
    }
    if (!response.ok) {
      throw new UpstreamError(
        `TradingView Data API returned HTTP ${response.status}: ${summarizeError(payload)}`,
        response.status,
      );
    }
    return payload;
  }
}

async function readBoundedText(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel("response size limit exceeded");
        throw new UpstreamError(
          "TradingView Data API response exceeded the size limit.",
          response.status,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

function summarizeError(payload: unknown): string {
  if (typeof payload === "string") return payload.slice(0, 300);
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const error = record.error;
    if (typeof error === "string") return error.slice(0, 300);
    if (error && typeof error === "object") {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string") return message.slice(0, 300);
    }
    if (typeof record.message === "string") return record.message.slice(0, 300);
  }
  return "upstream error";
}
