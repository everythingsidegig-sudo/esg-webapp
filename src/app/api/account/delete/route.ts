import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// ~100 years: Supabase's Admin API has no literal "forever" ban, only a
// duration string (Go's time.ParseDuration format).
const PERMANENT_BAN_DURATION = "876000h";

// Safe, structured server-side diagnostics: an operation label plus a
// whitelisted/validated code, status or boolean -- never a raw error message
// (which can echo back request data), never the session, cookies, the
// service-role key, or any other credential.
function logFailure(op: string, fields: Record<string, unknown>) {
  console.error(`[account/delete] ${op} failed`, fields);
}
function safeCode(code: unknown) {
  return typeof code === "string" && /^(PGRST\d{3}|[0-9A-Z]{5}|[a-z_]{3,40})$/.test(code) ? code : "unknown";
}

export async function POST() {
  const supabase = await createClient();
  // getUser() validates the token against Supabase Auth (unlike getSession(),
  // which only reads the cookie) -- this is the identity that gets deleted,
  // never a client-supplied id.
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError || !user) {
    if (userError) logFailure("auth.getUser", { code: safeCode(userError.code), status: userError.status });
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  // Built before anything is changed: a missing service-role key must fail
  // here, not after delete_own_account() has already anonymized the profile.
  let admin;
  try {
    admin = createAdminClient();
  } catch {
    logFailure("createAdminClient", { serviceRoleKeyConfigured: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY) });
    return NextResponse.json({ error: "Account deletion isn't available right now. Please try again later." }, { status: 500 });
  }

  // Runs as the caller (RLS-scoped to auth.uid()): decides whether this
  // account has marketplace history and, if so, anonymizes the profile in
  // place. See delete_own_account() for the full policy.
  const { data: hasHistory, error: rpcError } = await supabase.rpc("delete_own_account");
  if (rpcError) {
    logFailure("delete_own_account RPC", {
      code: safeCode(rpcError.code),
      serviceRoleKeyConfigured: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    });
    return NextResponse.json({ error: "Couldn't delete your account. Please try again." }, { status: 500 });
  }

  // Best-effort: a leftover photo file is far less harmful than blocking the
  // rest of deletion on a storage hiccup.
  try {
    const { data: files, error: listError } = await admin.storage.from("profile-photos").list(user.id);
    if (listError) logFailure("storage.list (non-fatal)", { code: safeCode(listError.name) });
    if (files?.length) {
      const { error: removeError } = await admin.storage.from("profile-photos").remove(files.map((file) => `${user.id}/${file.name}`));
      if (removeError) logFailure("storage.remove (non-fatal)", { code: safeCode(removeError.name) });
    }
  } catch (error) {
    logFailure("storage cleanup threw (non-fatal)", { code: safeCode(error instanceof Error ? error.name : undefined) });
  }

  if (hasHistory) {
    // auth.users can't be deleted for an account with marketplace history
    // (see delete_own_account()'s comment) -- permanently lock it instead.
    const { error: lockError } = await admin.auth.admin.updateUserById(user.id, {
      email: `deleted+${user.id}@deleted.invalid`,
      ban_duration: PERMANENT_BAN_DURATION,
    });
    if (lockError) {
      logFailure("auth.admin.updateUserById", { code: safeCode(lockError.code), status: lockError.status });
      return NextResponse.json({ error: "Couldn't finish deleting your account. Please try again." }, { status: 500 });
    }
  } else {
    const { error: deleteError } = await admin.auth.admin.deleteUser(user.id);
    if (deleteError) {
      logFailure("auth.admin.deleteUser", { code: safeCode(deleteError.code), status: deleteError.status });
      return NextResponse.json({ error: "Couldn't finish deleting your account. Please try again." }, { status: 500 });
    }
  }

  try {
    const { error: signOutError } = await supabase.auth.signOut({ scope: "global" });
    if (signOutError) logFailure("auth.signOut (non-fatal, deletion already succeeded)", { code: safeCode(signOutError.code), status: signOutError.status });
  } catch (error) {
    logFailure("auth.signOut threw (non-fatal, deletion already succeeded)", { code: safeCode(error instanceof Error ? error.name : undefined) });
  }

  return NextResponse.json({ ok: true });
}
