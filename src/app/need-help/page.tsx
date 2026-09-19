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

        <div
          aria-disabled="true"
          className="rounded-xl border border-neutral-200 bg-white p-6 shadow-sm"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="font-semibold">Find a Helper</div>
            <span className="rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-600">
              Coming soon
            </span>
          </div>
          <div className="mt-1 text-sm text-neutral-500">
            Find people nearby who can help with what you need.
          </div>
        </div>
      </div>
    </div>
  );
}
