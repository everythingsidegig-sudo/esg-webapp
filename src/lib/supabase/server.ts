import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

// Server-only: binds to the request's own session cookies, so a Route
// Handler identifies the caller from their real session rather than
// trusting anything the client sends (e.g. a body-supplied user id).
export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
          } catch {
            // Only a Server Component (not a Route Handler) can hit this;
            // its response isn't set from here anyway, so it's safe to ignore.
          }
        },
      },
    }
  );
}
