"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

// Bottom sheet on phones, centered dialog from the sm breakpoint up. Closes on
// Escape or a tap on the dimmed backdrop; keeps focus inside while open and
// restores it (and page scrolling) on close.
export default function OptionSheet({ title, onClose, children, footer }: {
  title: string; onClose: () => void; children: ReactNode; footer?: ReactNode;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    panel.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") { close.current(); return; }
      if (event.key !== "Tab" || !panel.current) return;
      const focusable = panel.current.querySelectorAll<HTMLElement>("button:not(:disabled), [href], input, [tabindex]:not([tabindex='-1'])");
      if (focusable.length === 0) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center sm:p-4"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        className="flex max-h-[85dvh] w-full flex-col rounded-t-2xl bg-white shadow-xl outline-none sm:max-w-md sm:rounded-2xl">
        <div aria-hidden="true" className="mx-auto mt-2 h-1.5 w-10 rounded-full bg-neutral-300 sm:hidden" />
        <h2 id={titleId} className="px-5 pb-1 pt-3 text-base font-semibold text-neutral-900">{title}</h2>
        <div className="flex-1 overflow-y-auto px-2 py-1">{children}</div>
        {footer && <div className="border-t border-neutral-200 px-5 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">{footer}</div>}
      </div>
    </div>
  );
}
