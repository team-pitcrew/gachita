// Official REST contract: docs.higgsfield.ai/docs/concepts/requests and the model API reference.
export class HiggsfieldError extends Error {
  constructor(code, uncertain = false) {
    super(code);
    this.name = "HiggsfieldError";
    this.code = code;
    this.uncertain = uncertain;
  }
}
export const higgsfieldReady = () =>
  Boolean(
    process.env.HF_CREDENTIALS ||
      (process.env.HF_API_KEY_ID && process.env.HF_API_KEY_SECRET),
  );
export function higgsfield({
  fetcher = fetch,
  credentials = process.env.HF_CREDENTIALS ||
    `${process.env.HF_API_KEY_ID ?? ""}:${process.env.HF_API_KEY_SECRET ?? ""}`,
  base = "https://api.higgsfield.ai",
} = {}) {
  const allowedUrl = (value) => {
    const u = new URL(value);
    if (
      u.origin !== base ||
      u.username ||
      u.password ||
      !u.pathname.startsWith("/requests/")
    )
      throw new HiggsfieldError("invalid_provider_url");
    return u.href;
  };
  async function call(url, method = "GET", body, signal) {
    let response;
    try {
      response = await fetcher(url, {
        method,
        headers: {
          Authorization: `Key ${credentials}`,
          "Content-Type": "application/json",
        },
        ...(body && { body: JSON.stringify(body) }),
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      });
    } catch {
      throw new HiggsfieldError("provider_connection", method === "POST");
    }
    if (!response.ok)
      throw new HiggsfieldError(
        `provider_http_${response.status}`,
        method === "POST" && response.status >= 500,
      );
    try {
      const text = await response.text();
      return text ? JSON.parse(text) : {};
    } catch {
      throw new HiggsfieldError("invalid_provider_response", method === "POST");
    }
  }
  return {
    async submit(model, input, signal) {
      const r = await call(`${base}/${model}`, "POST", input, signal);
      if (
        typeof r.request_id !== "string" ||
        !r.request_id ||
        !r.status_url ||
        !r.cancel_url
      )
        throw new HiggsfieldError("invalid_submission", true);
      try {
        return {
          id: r.request_id,
          statusUrl: allowedUrl(r.status_url),
          cancelUrl: allowedUrl(r.cancel_url),
        };
      } catch {
        throw new HiggsfieldError("invalid_submission_urls", true);
      }
    },
    status: async (r, signal) => {
      const v = await call(allowedUrl(r.statusUrl), "GET", null, signal);
      if (
        ![
          "queued",
          "in_progress",
          "completed",
          "failed",
          "nsfw",
          "canceled",
        ].includes(v.status)
      )
        throw new HiggsfieldError("invalid_provider_status");
      if (v.request_id && v.request_id !== r.id)
        throw new HiggsfieldError("provider_request_mismatch");
      return {
        status: v.status,
        videoUrl: v.status === "completed" ? v.video?.url : undefined,
      };
    },
    cancel: (r) => call(allowedUrl(r.cancelUrl), "POST"),
    remove: (r) =>
      call(`${base}/requests/${encodeURIComponent(r.id)}`, "DELETE"),
  };
}
