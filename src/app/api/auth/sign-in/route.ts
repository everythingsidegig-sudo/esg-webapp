import { createClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";

function reply(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

const invalid = () => reply({ code: "invalid_credentials" }, 401);

// Resolve usernames privately; Supabase still verifies every password.
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return reply({ code: "invalid_request" }, 403);
  if (!request.headers.get("content-type")?.startsWith("application/json")) {
    return reply({ code: "invalid_request" }, 415);
  }
  let body;
  try {
    const text = await request.text();
    if (text.length > 16384) return reply({ code: "invalid_request" }, 413);
    body = JSON.parse(text);
  } catch {
    return reply({ code: "invalid_request" }, 400);
  }
  if (!body || typeof body.username !== "string" || typeof body.password !== "string") {
    return reply({ code: "invalid_request" }, 400);
  }
  const username = body.username.trim();
  const password = body.password;
  if (!/^[A-Za-z0-9_]{1,40}$/.test(username) || !password || password.length > 4096) return invalid();

  try {
    const admin = createAdminClient();
    // Match the existing case-sensitive username uniqueness.
    const { data: profile, error: profileError } = await admin
      .from("profiles").select("id").eq("username", username).maybeSingle();
    if (profileError) return reply({ code: "username_signin_unavailable" }, 503);
    if (!profile) return invalid();

    const { data: account, error: accountError } = await admin.auth.admin.getUserById(profile.id);
    if (accountError || !account.user?.email) return invalid();

    // Never use the privileged client for password authentication.
    const auth = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
    );
    const { data, error } = await auth.auth.signInWithPassword({ email: account.user.email, password });
    if (error) {
      if (error.status === 429) return reply({ code: "over_request_rate_limit" }, 429);
      if (error.code === "email_not_confirmed") return reply({ code: "email_not_confirmed" }, 401);
      return invalid();
    }
    if (!data.session || data.user?.id !== profile.id) return invalid();

    return reply({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    });
  } catch {
    // Never log passwords, resolved emails, session tokens, or admin errors.
    return reply({ code: "username_signin_unavailable" }, 503);
  }
}
