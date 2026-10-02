import type { KeyboardEventHandler, ReactNode } from "react";

type SelectionChipProps = {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
  role?: "radio";
  tabIndex?: number;
  onKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
};

// Native buttons provide Enter/Space activation and inherit disabled fieldsets.
// The parent owns selection, allowing either one value or multiple values.
export default function SelectionChip({ selected, onClick, children, role, tabIndex, onKeyDown }: SelectionChipProps) {
  return <button type="button" role={role} aria-pressed={role === "radio" ? undefined : selected}
    aria-checked={role === "radio" ? selected : undefined} tabIndex={tabIndex} onKeyDown={onKeyDown} onClick={onClick}
    className={`relative inline-flex min-h-12 max-w-full items-center justify-center rounded-full border px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:cursor-not-allowed disabled:opacity-60 ${selected
      ? "border-emerald-700 bg-emerald-700 text-white enabled:hover:bg-emerald-800"
      : "border-neutral-300 bg-neutral-50 text-neutral-700 enabled:hover:border-emerald-700 enabled:hover:bg-emerald-50"}`}>
    <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
  </button>;
}
