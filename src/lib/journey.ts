// Shared, dependency-free journey rules; also exercised by Node regression tests.
export function safeNext(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\u0000-\u0020\u007f]/.test(value)) return "/";
  let decoded = value;
  try {
    for (let i = 0; i < 3; i++) decoded = decodeURIComponent(decoded);
    if (/[\\\u0000-\u001f\u007f]/.test(decoded) || decoded.startsWith("//")) return "/";
    const url = new URL(value, "https://esg.invalid");
    if (url.origin !== "https://esg.invalid") return "/";
    if (!/^\/(?:post|browse|location|my-gigs|profile|need-help|messages)?$/.test(url.pathname)
        && !/^\/gigs\/[0-9a-f-]{36}$/i.test(url.pathname)
        && !/^\/profile\/[A-Za-z0-9_]+$/.test(url.pathname)) return "/";
    return url.pathname + url.search + url.hash;
  } catch { return "/"; }
}

export function setupDestination(next: string | null | undefined) {
  return `/onboarding?next=${encodeURIComponent(safeNext(next))}`;
}

export function passwordError(password: string, confirm: string): string | null {
  if (password.length < 10 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
    return "Password must be at least 10 characters with a letter, a number, and a symbol.";
  }
  return password === confirm ? null : "Passwords don't match.";
}

export function registrationError(username: string, password: string, confirm: string): string | null {
  if (!/^[A-Za-z0-9]{6,40}$/.test(username)) return "Username must be 6–40 letters/numbers, with no spaces or symbols.";
  return passwordError(password, confirm);
}

export function approximateCoordinates(lat: number | null, lng: number | null) {
  if (lat == null && lng == null) return { lat: null, lng: null };
  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)
      || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new Error("Location coordinates are invalid. Enter a general area again.");
  return { lat: Math.round(lat * 100) / 100, lng: Math.round(lng * 100) / 100 };
}

export function gigInputError(title: string, description: string, amount: string, date: string, area: string, publish: boolean): string | null {
  if (!title.trim() || title.trim().length > 120) return "Enter a title of 1–120 characters.";
  if (!description.trim() || description.trim().length > 50) return "Enter a description of 1–50 characters.";
  if (!area.trim() || area.trim().length > 200) return "Enter a general area of 1–200 characters, not a street address.";
  const price = Number(amount);
  if (!Number.isFinite(price) || price <= 0 || price > 9999999999.99 || !/^\d+(\.\d{1,2})?$/.test(amount)) return "Enter a positive amount with at most two decimal places.";
  if ((publish && !date) || (date && (!Number.isFinite(Date.parse(date)) || Date.parse(date) <= Date.now()))) return "Pick a future date/time before posting.";
  return null;
}

export function friendlyError(error: unknown, fallback = "Something went wrong. Please try again.") {
  const value = error as { code?: string; message?: string };
  if (value?.code === "23505") return "That username is already taken. Choose another.";
  if (value?.code === "email_not_confirmed") return "Verify your email using the confirmation link before signing in.";
  if (value?.code === "invalid_credentials") return "That email or password isn't right.";
  if (value?.code === "user_already_exists" || value?.code === "email_exists") return "This email may already have an account. Try signing in.";
  if (value?.code === "22023") return value.message ?? fallback;
  if (value?.code === "429" || value?.code === "over_email_send_rate_limit" || value?.code === "over_request_rate_limit") return "Too many requests. Please wait a few minutes and try again.";
  // 42501 is Postgres' "insufficient privilege". Our own functions raise it as 'Authentication required'
  // when there is no session (that is the only case that means "sign in again"); anything else --
  // a table or column the role may not write, row-level security, 'Not authorized' -- is a permission
  // problem, and asking a signed-in person to sign in again would only send them in circles.
  if (value?.code === "42501") {
    return /^authentication required\.?$/i.test(value.message ?? "")
      ? "Please sign in again before continuing."
      : "You don't have permission to make that change. If this keeps happening, contact support.";
  }
  if (value?.code === "weak_password") return "Choose a stronger password. Your account's password rules may require more characters.";
  if (value?.code === "email_address_invalid") return "That email address isn't valid. Check it and try again.";
  if (value?.code === "user_banned") return "This account is no longer available.";
  if (value?.code === "signup_disabled") return "Registration is currently unavailable. Please try again later.";
  // Supabase reports a username collision inside its signup trigger (a race with the pre-check) this way.
  if (value?.message === "Database error saving new user") return "We couldn't create your account. That username may have just been taken -- try another.";
  return fallback;
}

// For lifecycle RPCs (claim, select, approve, ...): only messages our own
// functions raise (SQLSTATE P0001, e.g. "Gig is not open for claims") are shown;
// anything else (network, grants, constraint names) gets a generic message.
export function rpcActionError(error: unknown, fallback = "Couldn't complete that action. Please try again.") {
  const value = error as { code?: string; message?: string };
  if (value?.code === "P0001" && typeof value.message === "string" && value.message) return value.message;
  if (value?.code === "42501") return "Please sign in again before continuing.";
  if (value?.code === "429" || value?.code === "over_request_rate_limit") return "Too many requests. Please wait a few minutes and try again.";
  return fallback;
}

// ---------------------------------------------------------------------------
// Signed-out helper browsing: a helper profile is the first thing that needs an
// account. These helpers keep the intended destination narrow (a helper profile
// path only), validated by safeNext, and short-lived.
// ---------------------------------------------------------------------------
const HELPER_USERNAME = /^[A-Za-z0-9_]{1,40}$/;

export function isHelperProfileDestination(value: string | null | undefined): boolean {
  if (!value) return false;
  const safe = safeNext(value);
  if (safe === "/") return false;
  try {
    const path = new URL(safe, "https://esg.invalid").pathname;
    return /^\/profile\/[A-Za-z0-9_]{1,40}$/.test(path);
  } catch { return false; }
}

// Link to a helper profile that also carries the search context (the category
// the visitor was browsing) so the profile can lead back to the same results.
export function helperProfileHref(username: string, category?: string | null): string | null {
  if (!HELPER_USERNAME.test(username)) return null;
  const context = category && category.length <= 60 ? `?from=find-helper&category=${encodeURIComponent(category)}` : "";
  return `/profile/${username}${context}`;
}

export function helperUsernameFromDestination(value: string | null | undefined): string | null {
  if (!isHelperProfileDestination(value)) return null;
  return new URL(safeNext(value), "https://esg.invalid").pathname.slice("/profile/".length);
}

// Where "Continue browsing" goes: back to Find a Helper, keeping the category.
export function findHelperHref(category?: string | null, allowed?: readonly string[]): string {
  if (!category || category.length > 60 || (allowed && !allowed.includes(category))) return "/find-helper";
  return `/find-helper?category=${encodeURIComponent(category)}`;
}

// Registration finishes in another tab (the verification email), so the
// destination is kept in localStorage for a short time, then forgotten.
export const AUTH_DESTINATION_KEY = "esg:post-auth-destination";
const AUTH_DESTINATION_TTL_MS = 30 * 60 * 1000;
type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function rememberAuthDestination(destination: string | null | undefined, storage?: KeyValueStorage, now = Date.now()): boolean {
  if (!destination || !isHelperProfileDestination(destination)) return false;
  try {
    (storage ?? localStorage).setItem(AUTH_DESTINATION_KEY, JSON.stringify({ path: safeNext(destination), expires: now + AUTH_DESTINATION_TTL_MS }));
    return true;
  } catch { return false; }
}

// One-shot: returns the remembered destination (re-validated) and forgets it.
export function takeAuthDestination(storage?: KeyValueStorage, now = Date.now()): string | null {
  try {
    const store = storage ?? localStorage;
    const raw = store.getItem(AUTH_DESTINATION_KEY);
    store.removeItem(AUTH_DESTINATION_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (typeof value?.path !== "string" || typeof value.expires !== "number" || value.expires < now) return null;
    return isHelperProfileDestination(value.path) ? safeNext(value.path) : null;
  } catch { return null; }
}
