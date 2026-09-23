import Link from "next/link";

export default function NeedHelp() {
  return (
    <div className="mx-auto max-w-md space-y-5">
      <div>
        <h1 className="text-xl font-semibold">I Need Help</h1>
        <p className="mt-1 text-sm text-neutral-500">Choose how you want to find help nearby.</p>
      </div>

      <div className="grid gap-4">
        <Link
          href="/post"
          className="rounded-xl border border-neutral-200 bg-white p-6 shadow-sm transition hover:shadow-md"
        >
          <div className="font-semibold">Post a Gig</div>
          <div className="mt-1 text-sm text-neutral-500">
            Create a gig and let people nearby offer to help.
          </div>
        </Link>

        <Link
          href="/find-helper"
          className="rounded-xl border border-neutral-200 bg-white p-6 shadow-sm transition hover:shadow-md"
        >
          <div className="font-semibold">Find a Helper</div>
          <div className="mt-1 text-sm text-neutral-500">
            Find people nearby who can help with what you need.
          </div>
        </Link>
      </div>
    </div>
  );
}
