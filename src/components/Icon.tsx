// One flat, thick-line icon set for the whole app (24x24, 2px round strokes, inherits text colour), so the
// header, cards, lists and navigation all share a single style instead of mixing emoji and line art.
const PATHS = {
  home: "M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10",
  search: "M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-5-5",
  gigs: "M8 3h8l1 2h3v16H4V5h3l1-2zM8 11h8M8 15h5",
  profile: "M12 12a4 4 0 100-8 4 4 0 000 8zM4 21c0-4 4-6 8-6s8 2 8 6",
  chat: "M21 12a8 8 0 01-11.6 7.1L4 20l1-4.6A8 8 0 1121 12z",
  bell: "M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0",
  hand: "M18 11V6a2 2 0 00-4 0M14 10V4a2 2 0 00-4 0v6M10 10.5V6a2 2 0 00-4 0v8M18 8a2 2 0 114 0v6a8 8 0 01-8 8h-2c-2.5 0-4-1-5.4-2.4L3 16a2 2 0 013-2.6L8 15",
  wallet: "M19 7V4a1 1 0 00-1-1H5a2 2 0 000 4h15a1 1 0 011 1v4h-3a2 2 0 000 4h3a1 1 0 001-1v-2M3 5v14a2 2 0 002 2h15a1 1 0 001-1v-4",
  clipboard: "M9 3h6v4H9zM8 5H6a2 2 0 00-2 2v13a2 2 0 002 2h12a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 14l2 2 4-4",
  people: "M17 21v-2a4 4 0 00-4-4H7a4 4 0 00-4 4v2M10 11a4 4 0 100-8 4 4 0 000 8zM17 11l2 2 4-4",
  thumbsUp: "M7 10v12M15 5.9L14 10h5.8a2 2 0 011.9 2.6l-2.3 8a2 2 0 01-1.9 1.4H4a2 2 0 01-2-2v-8a2 2 0 012-2h2.8a2 2 0 001.8-1.1L12 2a3.1 3.1 0 013 3.9z",
  chevron: "M9 5l7 7-7 7",
} as const;

export type IconName = keyof typeof PATHS;

export default function Icon({ name, className = "h-6 w-6", strokeWidth = 2 }: { name: IconName; className?: string; strokeWidth?: number }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <path d={PATHS[name]} />
    </svg>
  );
}
