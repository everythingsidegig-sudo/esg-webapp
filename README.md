# ESG — MVP Web App

Everything SideGig (ESG): a peer-to-peer gig marketplace. This is the core-loop MVP —
Sign In/Register, Post a Gig, Browse/Claim, Select Provider, Start handshake, Chat,
Complete/Incomplete + payment amounts, and WOM/Lemon feedback. See
`../CONSOLIDATED_SPEC.md` for the full functional spec this was scoped down from.

Stack: Next.js (App Router) + Tailwind, Supabase (Postgres + Auth + Storage + Realtime).

## 1. Create a free Supabase project

1. Go to https://supabase.com and create a free account/project (you'll need to do this
   yourself — account creation isn't something I can do on your behalf).
2. Apply `supabase/migrations/0001_init.sql`, `0002_security_hardening.sql`,
   `0003_lifecycle_integrity.sql`, and `0004_onboarding_post_gig.sql` once, in that
   order, using a trusted migration role. Existing projects apply only unapplied
   migrations. Migration 0004 is required by profile loading, setup, and posting.
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

## Run with Docker Desktop (local development)

Use Docker Desktop with Linux containers (WSL 2 backend on Windows). Run the
commands below from this project directory in PowerShell or a terminal.
The locked Supabase client requires Node >=22, so the Docker image uses Node 22.

Create `.env.local` if it does not already exist:

```powershell
Copy-Item .env.local.example .env.local
```

Replace the example values with your hosted Supabase project's
`NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Compose loads this
file at runtime; environment files are excluded from the image. No local Supabase
or database containers are created. Add
`http://localhost:3001/auth/callback` to Supabase's authentication Redirect URLs.

Build and start only ESG:

```powershell
docker compose -p esg-local-dev build esg-web
docker compose -p esg-local-dev up -d esg-web
docker compose -p esg-local-dev logs --tail 100 esg-web
```

Open http://localhost:3001. The `esg-web` service creates container
`esg-local-dev-web` and maps **host 3001 to container 3000**. It does not publish
host ports 3000 or 8000. The explicit Compose project name isolates ESG's resources
from PINNSim; these commands operate only on ESG.

Source files are bind-mounted for hot reload. Webpack polling supports file
changes through Windows Docker Desktop mounts. Container dependencies and Next.js
cache use separate ESG named volumes, masking any host `node_modules` or `.next`.
Next.js listens on `0.0.0.0:3000` inside the container.

Stop ESG (keeps dependencies and cache for the next start):

```powershell
docker compose -p esg-local-dev down
```

Rebuild and refresh dependencies after changing `package.json` or the lockfile:

```powershell
docker compose -p esg-local-dev down -v
docker compose -p esg-local-dev build esg-web
docker compose -p esg-local-dev up -d esg-web
```

The `-v` removes only this Compose project's dependency/cache volumes. After
changing `.env.local`, recreate the service with
`docker compose -p esg-local-dev up -d --force-recreate esg-web`.
Check the published port with `docker compose -p esg-local-dev port esg-web 3000`.

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

For the onboarding-to-posting journey, deployment steps, verification results,
and remaining UX differences, see [ONBOARDING_POST_GIG.md](ONBOARDING_POST_GIG.md).

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
