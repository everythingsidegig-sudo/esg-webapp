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
  const sizing = size === "compact" ? "min-h-8 px-3 py-1 text-xs" : "min-h-12 px-4 py-2 text-sm";
  return <button type="button" role={role} aria-pressed={role === "radio" ? undefined : selected}
    aria-checked={role === "radio" ? selected : undefined} tabIndex={tabIndex} onKeyDown={onKeyDown} onClick={onClick}
    className={`relative inline-flex max-w-full items-center justify-center rounded-full border font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:cursor-not-allowed disabled:opacity-60 ${sizing} ${selected
      ? "border-emerald-700 bg-emerald-700 text-white enabled:hover:bg-emerald-800"
      : "border-neutral-300 bg-neutral-50 text-neutral-700 enabled:hover:border-emerald-700 enabled:hover:bg-emerald-50"}`}>
    <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
  </button>;
}
