// Landing / Home "How it works": the same three steps for people who post and people who help.
// Illustrations are inline SVG so they render crisply at any size and follow the brand palette.
const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;

function ClipboardIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 48 48" className="h-12 w-12 text-brand-600">
      <rect x="9" y="8" width="26" height="33" rx="4" fill="#f6f2ff" stroke="currentColor" strokeWidth="2" />
      <path {...stroke} d="M16 8V6h12v2M15 19l2 2 3-4M15 28l2 2 3-4M24 19h7M24 28h7" />
      <path d="M33 30l8-9 3 3-8 9-4 1z" fill="#ffb02e" stroke="#b45309" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

function PeopleIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 48 48" className="h-12 w-12 text-brand-600">
      <rect x="4" y="12" width="17" height="24" rx="3" fill="#ece4ff" stroke="currentColor" strokeWidth="1.6" />
      <rect x="27" y="12" width="17" height="24" rx="3" fill="#ece4ff" stroke="currentColor" strokeWidth="1.6" />
      <rect x="12" y="8" width="24" height="31" rx="4" fill="#fff" stroke="currentColor" strokeWidth="2" />
      <circle cx="24" cy="21" r="5" fill="#a174f4" />
      <path d="M14 36c1-6 5-8 10-8s9 2 10 8z" fill="#6d28d9" />
      <circle cx="35" cy="35" r="7" fill="#22c55e" />
      <path {...stroke} stroke="#fff" d="M31.5 35l2.5 2.5 4.5-5" />
    </svg>
  );
}

function HandshakeIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 48 48" className="h-12 w-12 text-brand-600">
      <path d="M4 18l9-3 7 4" fill="none" stroke="#5b21b6" strokeWidth="4" strokeLinecap="round" />
      <path d="M44 18l-9-3-7 4" fill="none" stroke="#7c3aed" strokeWidth="4" strokeLinecap="round" />
      <path d="M14 17l10-2 8 4-6 8c-2 3-6 3-8 0l-6-6z" fill="#ffd9b0" stroke="#d97706" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M20 30l4 4c2 2 5 1 6-1l5-7" fill="none" stroke="#d97706" strokeWidth="1.6" strokeLinecap="round" />
      <path {...stroke} stroke="#f59e0b" d="M24 4v5M15 7l2 4M33 7l-2 4" />
    </svg>
  );
}

const STEPS = [
  { title: "Post or Browse", text: "Post a task or find gigs nearby.", icon: <ClipboardIcon /> },
  { title: "Connect", text: "Choose a helper or get selected.", icon: <PeopleIcon /> },
  { title: "Complete & Review", text: "Finish the gig and share feedback.", icon: <HandshakeIcon /> },
];

export default function HowItWorks() {
  return (
    <section aria-label="How it works" className="rounded-2xl bg-white p-5 shadow-sm">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">How it works</h2>
      <ol className="mt-4 grid grid-cols-[1fr_auto_1fr_auto_1fr] items-start gap-x-1 text-center">
        {STEPS.map((step, index) => (
          <li key={step.title} className="contents">
            <div className="flex flex-col items-center gap-1.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-100 text-sm font-bold text-brand-800">{index + 1}</span>
              {step.icon}
              <h3 className="text-[0.95rem] font-bold leading-tight">{step.title}</h3>
              <p className="text-xs leading-snug text-neutral-500">{step.text}</p>
            </div>
            {index < STEPS.length - 1 && <span aria-hidden="true" className="mt-12 text-xl font-bold text-brand-600">→</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}
