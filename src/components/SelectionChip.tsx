import type { KeyboardEventHandler, ReactNode } from "react";

type SelectionChipProps = {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
  role?: "radio";
  tabIndex?: number;
  onKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
  // "compact" is a smaller/secondary size for a chip that's subordinate to
  // another selection (e.g. a specialization under its category). Defaults
  // to the original size so every existing call site is unaffected.
  size?: "default" | "compact";
};

// Native buttons provide Enter/Space activation and inherit disabled fieldsets.
// The parent owns selection, allowing either one value or multiple values.
export default function SelectionChip({ selected, onClick, children, role, tabIndex, onKeyDown, size = "default" }: SelectionChipProps) {
  const compact = size === "compact";
  const sizing = compact ? "min-h-8 gap-1 px-3 py-1 text-xs" : "min-h-12 px-4 py-2 text-sm";
  // Compact chips are secondary options (specializations), so they read as a
  // different kind of control: dashed/white when off, tinted with a check when
  // on -- never a smaller copy of a selected primary chip.
  const look = compact
    ? selected
      ? "border-emerald-600 bg-emerald-50 text-emerald-800 enabled:hover:bg-emerald-100"
      : "border-dashed border-neutral-300 bg-white text-neutral-600 enabled:hover:border-emerald-600 enabled:hover:text-emerald-800"
    : selected
      ? "border-emerald-700 bg-emerald-700 text-white enabled:hover:bg-emerald-800"
      : "border-neutral-300 bg-neutral-50 text-neutral-700 enabled:hover:border-emerald-700 enabled:hover:bg-emerald-50";
  return <button type="button" role={role} aria-pressed={role === "radio" ? undefined : selected}
    aria-checked={role === "radio" ? selected : undefined} tabIndex={tabIndex} onKeyDown={onKeyDown} onClick={onClick}
    className={`relative inline-flex max-w-full items-center justify-center rounded-full border font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:cursor-not-allowed disabled:opacity-60 ${sizing} ${look}`}>
    {compact && selected && <span aria-hidden="true">✓</span>}
    <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
  </button>;
}
