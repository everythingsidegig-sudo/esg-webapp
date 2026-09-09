import { createBrowserClient } from "@supabase/ssr";

// Not using the generated-style `Database` generic here: hand-written types in
// database.types.ts are for app-level Row shapes (cast at call sites with `as Gig[]` etc.),
// not a full PostgREST GenericSchema — passing it as the client generic fights supabase-js's
// type inference on .insert()/.update()/.rpc() far more than it helps for an MVP.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
