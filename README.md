# ESG — MVP Web App

Everything SideGig (ESG): a peer-to-peer gig marketplace. This is the core-loop MVP —
Sign In/Register, Post a Gig, Browse/Claim, Select Provider, Start handshake, Chat,
Complete/Incomplete + payment amounts, and WOM/Lemon feedback. See
`../CONSOLIDATED_SPEC.md` for the full functional spec this was scoped down from.

Stack: Next.js (App Router) + Tailwind, Supabase (Postgres + Auth + Storage + Realtime).

## 1. Create a free Supabase project

1. Go to https://supabase.com and create a free account/project (you'll need to do this
   yourself — account creation isn't something I can do on your behalf).
2. In the new project, open **SQL Editor** and run the contents of
   `supabase/migrations/0001_init.sql` once. This creates every table, RLS policy, and
   the RPC functions the app calls (claim, select, start, complete/incomplete, payment,
   feedback).
3. Under **Project Settings → Data API**, confirm the Realtime toggle is on for the
   `public` schema (default is on).
4. Under **Authentication → URL Configuration**, add your local dev URL
   (`http://localhost:3000/auth/callback`) and, once deployed, your Vercel URL
   (`https://your-app.vercel.app/auth/callback`) to the Redirect URLs allowlist.
5. Under **Project Settings → API**, copy the **Project URL** and the **anon public key**.

## 2. Configure environment variables

Copy `.env.local.example` to `.env.local` and fill in the two values from step 1.5:

```bash
cp .env.local.example .env.local
```

## 3. Run locally

```bash
npm install
npm run dev
```

Open http://localhost:3000. Test the full core loop with two accounts (e.g. two browser
profiles or one regular + one incognito window): sign up as both, post a gig as one,
claim it as the other, select the provider, start → approve start, chat, mark
complete/incomplete, enter payment amounts, and leave feedback.

## 4. Deploy for free (Vercel)

1. Push this repo to GitHub.
2. Go to https://vercel.com, sign in (or create a free account), and "Import Project"
   from that GitHub repo, pointing the root directory at `webapp/`.
3. Add the same two environment variables (`NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY`) in the Vercel project's Environment Variables
   settings.
4. Deploy. Then go back to Supabase's Authentication → URL Configuration and add the
   resulting `https://<your-app>.vercel.app/auth/callback` URL.

Both Vercel's Hobby tier and Supabase's Free tier cover this app's expected traffic at
no cost.

## What's simplified vs. the full spec (see CONSOLIDATED_SPEC.md)

- Fixed-price gigs only for now — Price Negotiation (3-round) isn't built yet.
- Direct Gig Request, Repost, Report/Block/Safety, and Dispute *adjudication* aren't
  built — a mismatch (completion status, pay type, or payment amount) flips a gig to
  "Disputed" and stops there with a static message, per the spec's own note that
  adjudication rules were never defined.
- Delay/no-response escalation on the Start handshake isn't built — it's a simple
  Start → Approve exchange for now.
- Sign-up uses Supabase's built-in email confirmation link instead of a custom OTP
  screen, and profile photo is optional at signup (add it afterward on /profile) rather
  than mandatory during registration.
- Sign-in is email + password only (no username/phone identifier) for MVP.
