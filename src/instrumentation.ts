// Routes server-side fetch (Supabase, etc.) through the corporate proxy in local dev.
// Node's built-in fetch does not honor HTTP_PROXY/HTTPS_PROXY on its own, which left
// proxy.ts unable to reach Supabase and fail closed with a 503 on networks that require
// an outbound proxy. Only runs in development, and only when a proxy is actually set, so
// it never touches production.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NODE_ENV !== "development") return;

  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!proxyUrl) return;

  const { ProxyAgent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}
