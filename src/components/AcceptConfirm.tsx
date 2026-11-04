"use client";

import { useState } from "react";
import { formatMoney, offerError } from "@/lib/money";
import { priceLabel } from "@/lib/helper-request";
import type { GigWithTags } from "@/lib/database.types";

// ESG Gig Swipe Discovery v1.0, confirmed default: swipe-right/Accept opens this
// confirmation rather than submitting instantly, to cut down on accidental claims.
// Fixed price just confirms the listed amount; negotiable reuses the exact same
// offer-entry convention already on the gig detail page (same validation, same
// default-to-listed-amount behavior), so this isn't a second, diverging offer UI.
export default function AcceptConfirm({
  gig,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  gig: GigWithTags;
  busy: boolean;
  error: string | null;
  onConfirm: (amount: number, message: string | null) => void;
  onCancel: () => void;
}) {
  const negotiable = gig.price_type === "negotiable";
  const [offerAmount, setOfferAmount] = useState<string>(String(gig.amount));
  const [message, setMessage] = useState("");
  const problem = offerError(offerAmount);

  return (
    <div role="dialog" aria-label="Confirm offer" className="space-y-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
      <h3 className="font-semibold text-emerald-900">Accept &ldquo;{gig.title}&rdquo;?</h3>
      {negotiable ? (
        <>
          <label className="block text-sm text-emerald-900">Your offer (CAD)
            <input type="number" inputMode="decimal" min="0.01" step="0.01" required disabled={busy} value={offerAmount}
              onChange={(e) => setOfferAmount(e.target.value)}
              className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 disabled:opacity-60" />
          </label>
          <p className="text-xs text-emerald-800">The poster&apos;s budget is {formatMoney(gig.amount)} ({priceLabel(gig.price_type)}). You can offer a different price.</p>
          <label className="block text-sm text-emerald-900">Message (optional)
            <textarea maxLength={500} rows={2} disabled={busy} value={message} onChange={(e) => setMessage(e.target.value)}
              className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 disabled:opacity-60" />
          </label>
        </>
      ) : (
        <p className="text-sm text-emerald-900">You&apos;re offering to help for <strong>{formatMoney(gig.amount)}</strong> ({priceLabel(gig.price_type)}).</p>
      )}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button type="button" disabled={busy || (negotiable && !!problem)}
          onClick={() => onConfirm(negotiable ? Number(offerAmount) : gig.amount, negotiable ? (message.trim() || null) : null)}
          className="flex-1 rounded-lg bg-emerald-600 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60">
          {busy ? "Sending…" : "Confirm"}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}
          className="flex-1 rounded-lg border border-neutral-300 bg-white py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-60">
          Cancel
        </button>
      </div>
    </div>
  );
}
