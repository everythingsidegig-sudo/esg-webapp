import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Route-level protection for helper profiles (/profile/<username>).
//
// Find a Helper itself is public: anyone can search and see the helper list.
// Opening a helper's profile needs an account, and that is enforced here, on the
// server, before the page is rendered -- not only by a client-side prompt that a
// visitor could skip by typing the URL. Signed-out requests are sent to Sign In
// with the profile as the (validated) destination; the sign-in page validates it
// again with safeNext. The visitor's own page (/profile) is not matched here:
// it keeps its AuthGuard.
//
// The session is verified with Supabase Auth (getUser), never trusted from the
// cookie alone. If the auth service cannot be reached the request fails closed
// with a 503 instead of redirecting, so a signed-in user is never bounced in a
// loop and a signed-out one never gets the page.
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  try {
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() { return request.cookies.getAll(); },
          setAll(cookiesToSet) {
            // Keep a refreshed session in step for the rest of this request and the browser.
            cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
            response = NextResponse.next({ request });
            cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
          },
        },
      },
    );
    const { data: { user }, error } = await supabase.auth.getUser();
    if (user) return response;

    const status = (error as { status?: number } | null)?.status;
    const signedOut = !error || error.name === "AuthSessionMissingError" || status === 400 || status === 401 || status === 403;
    if (!signedOut) throw error;
  } catch {
    return new NextResponse("Sign-in is temporarily unavailable. Please try again in a moment.", {
      status: 503,
      headers: { "Cache-Control": "no-store", "Retry-After": "30" },
    });
  }

  const signIn = new URL("/auth/sign-in", request.url);
  signIn.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`);
  signIn.searchParams.set("reason", "helper-profile");
  const redirect = NextResponse.redirect(signIn);
  redirect.headers.set("Cache-Control", "no-store");
  return redirect;
}

export const config = {
  matcher: ["/profile/:username"],
};
