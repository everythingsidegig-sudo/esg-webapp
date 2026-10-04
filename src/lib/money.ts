// One place that decides how money is shown. Amounts are plain numbers in the
// database (numeric(12,2)); the app has no per-gig currency, so the display
// currency is a single app-wide setting.
export const CURRENCY = "SEK";

export function formatMoney(amount: number | string | null | undefined) {
  if (amount == null || amount === "") return "";
  const value = Number(amount);
  if (!Number.isFinite(value)) return "";
  return `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${CURRENCY}`;
}

// UX-only check mirroring create_claim's server rules (the server is the authority).
export function offerError(amount: string): string | null {
  const text = amount.trim();
  const value = Number(text);
  if (!/^\d+(\.\d{1,2})?$/.test(text) || !Number.isFinite(value) || value <= 0 || value > 9999999999.99) {
    return "Enter a positive offer with at most two decimal places.";
  }
  return null;
}
