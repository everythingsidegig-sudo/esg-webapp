"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import AuthGuard from "@/components/AuthGuard";
import { useAuth } from "@/lib/auth-context";
import { createClient } from "@/lib/supabase/client";

const SERVICE_TYPES = [
  "Yard Work",
  "Moving Help",
  "Cleaning",
  "Handyman",
  "Delivery",
  "Pet Care",
  "Tech Help",
  "Other",
];

function PostGigForm() {
  const supabase = createClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();

  const [serviceType, setServiceType] = useState(SERVICE_TYPES[0]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [locationText, setLocationText] = useState(searchParams.get("loc") ?? "");
  const [photo, setPhoto] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const lat = searchParams.get("lat");
  const lng = searchParams.get("lng");

  async function submit(publish: boolean) {
    setError(null);

    if (!title.trim() || !description.trim() || !locationText.trim()) {
      setError("Service type, title, description, and location are required.");
      return;
    }
    const amountNum = Number(amount);
    if (!amountNum || amountNum <= 0) {
      setError("Enter a valid positive amount.");
      return;
    }
    if (publish && (!scheduledAt || new Date(scheduledAt) <= new Date())) {
      setError("Pick a future date/time before posting.");
      return;
    }

    setSubmitting(true);

    let photoUrl: string | null = null;
    if (photo && user) {
      const path = `${user.id}/${Date.now()}-${photo.name}`;
      const { error: uploadError } = await supabase.storage.from("gig-photos").upload(path, photo);
      if (uploadError) {
        setError("Photo upload failed: " + uploadError.message);
        setSubmitting(false);
        return;
      }
      photoUrl = supabase.storage.from("gig-photos").getPublicUrl(path).data.publicUrl;
    }

    const { data, error: insertError } = await supabase
      .from("gigs")
      .insert({
        poster_id: user!.id,
        service_type: serviceType,
        title,
        description,
        photo_url: photoUrl,
        amount: amountNum,
        price_type: "fixed",
        scheduled_at: scheduledAt ? new Date(scheduledAt).toISOString() : null,
        location_text: locationText,
        lat: lat ? Number(lat) : null,
        lng: lng ? Number(lng) : null,
        status: publish ? "active" : "draft",
      })
      .select()
      .single();

    setSubmitting(false);
    if (insertError) {
      setError(insertError.message);
      return;
    }
    router.push(publish ? `/gigs/${data.id}` : "/my-gigs");
  }

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <h1 className="text-xl font-semibold">Post a Gig</h1>

      <div>
        <label className="mb-1 block text-sm font-medium">Service Type</label>
        <select
          value={serviceType}
          onChange={(e) => setServiceType(e.target.value)}
          className="w-full rounded-lg border border-neutral-300 px-3 py-2"
        >
          {SERVICE_TYPES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium">Gig Title</label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full rounded-lg border border-neutral-300 px-3 py-2"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium">Brief Description</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={280}
          rows={3}
          className="w-full rounded-lg border border-neutral-300 px-3 py-2"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium">Photo (optional)</label>
        <input
          type="file"
          accept="image/*"
          onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
          className="w-full text-sm"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="mb-1 block text-sm font-medium">Amount ($)</label>
          <input
            type="number"
            min="1"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-full rounded-lg border border-neutral-300 px-3 py-2"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium">Pricing</label>
          <select disabled className="w-full rounded-lg border border-neutral-300 bg-neutral-100 px-3 py-2 text-neutral-500">
            <option>Fixed Price</option>
          </select>
          <p className="mt-1 text-xs text-neutral-400">Negotiable pricing is coming soon.</p>
        </div>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium">Date/Time</label>
        <input
          type="datetime-local"
          value={scheduledAt}
          onChange={(e) => setScheduledAt(e.target.value)}
          className="w-full rounded-lg border border-neutral-300 px-3 py-2"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium">Gig Location</label>
        <input
          value={locationText}
          onChange={(e) => setLocationText(e.target.value)}
          className="w-full rounded-lg border border-neutral-300 px-3 py-2"
        />
        <p className="mt-1 text-xs text-neutral-400">
          Don&apos;t share your exact address until you&apos;ve selected a provider.
        </p>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex gap-3">
        <button
          onClick={() => submit(false)}
          disabled={submitting}
          className="flex-1 rounded-lg border border-neutral-300 py-2.5 font-medium hover:bg-neutral-100 disabled:opacity-60"
        >
          Save as Draft
        </button>
        <button
          onClick={() => submit(true)}
          disabled={submitting}
          className="flex-1 rounded-lg bg-emerald-600 py-2.5 font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
        >
          {submitting ? "Posting…" : "Post Gig"}
        </button>
      </div>
    </div>
  );
}

export default function PostGig() {
  return (
    <AuthGuard>
      <Suspense>
        <PostGigForm />
      </Suspense>
    </AuthGuard>
  );
}
