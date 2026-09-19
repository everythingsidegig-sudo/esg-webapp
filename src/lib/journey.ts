// Shared, dependency-free journey rules; also exercised by Node regression tests.
export function safeNext(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || /[\u0000-\u0020\u007f]/.test(value)) return "/";
  let decoded = value;
  try {
    for (let i = 0; i < 3; i++) decoded = decodeURIComponent(decoded);
    if (/[\\\u0000-\u001f\u007f]/.test(decoded) || decoded.startsWith("//")) return "/";
    const url = new URL(value, "https://esg.invalid");
    if (url.origin !== "https://esg.invalid") return "/";
    if (!/^\/(?:post|browse|location|my-gigs|profile|need-help)?$/.test(url.pathname)
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
  if (!description.trim() || description.trim().length > 280) return "Enter a description of 1–280 characters.";
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
  if (value?.code === "42501") return "Please sign in again before continuing.";
  if (value?.code === "weak_password") return "Choose a stronger password. Your account's password rules may require more characters.";
  return fallback;
}
