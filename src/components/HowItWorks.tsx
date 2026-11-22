import Icon, { type IconName } from "@/components/Icon";

// Landing / Home "How it Works": the same three steps for people who post and people who help, as a
// vertical list (icon in a light-purple rounded square, numbered bold title, dark-gray description).
const STEPS: { title: string; text: string; icon: IconName }[] = [
  { title: "Post or Browse", text: "Post a task or find gigs nearby.", icon: "clipboard" },
  { title: "Connect", text: "Choose a helper or get selected.", icon: "people" },
  { title: "Complete & Review", text: "Finish the gig and share feedback.", icon: "thumbsUp" },
];

export default function HowItWorks() {
  return (
    <section aria-label="How it works" className="rounded-3xl border border-neutral-200 bg-white p-5 shadow-sm">
      <h2 className="text-xl font-extrabold text-neutral-900">How it Works</h2>
      <ol className="mt-4 space-y-4">
        {STEPS.map((step, index) => (
          <li key={step.title} className="flex items-center gap-4">
            <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-brand-100 text-brand-700">
              <Icon name={step.icon} className="h-7 w-7" />
            </span>
            <div>
              <h3 className="text-base font-bold text-neutral-900">{index + 1}. {step.title}</h3>
              <p className="text-neutral-700">{step.text}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
