import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// Server-only, service-role client. Never import this from a Client
// Component or anything that could reach a browser bundle -- it bypasses RLS
// entirely. Reserved for the handful of operations that genuinely require
// admin privileges: the Auth Admin API and cleaning up a user's own storage
// objects during account deletion (src/app/api/account/delete/route.ts).
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured on the server.");
  }
  return createSupabaseClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
}
