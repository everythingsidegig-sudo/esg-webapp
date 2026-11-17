import { fromRows, summarize } from "@/lib/service-selection";

export type OfferedRow = { service_id: string; subservice_id: string | null; custom_text: string | null };

// What a member offers ("Services to Make Money"), for their public profile: Category > Service >
// Subservice, plus any "Other" text they added under a service. Services that need a licence are left
// out until a verification control exists, so selecting one never advertises it (spec AC-17). The NEED
// list never reaches this component: the database only returns OFFER rows.
export default function OfferedServices({ rows }: { rows: OfferedRow[] }) {
  const groups = summarize(fromRows(rows.map((row) => ({
    subservice_id: row.subservice_id, service_id: row.service_id, is_custom: row.custom_text !== null, custom_text: row.custom_text,
  }))))
    .map((group) => ({ ...group, services: group.services.filter(({ service }) => !service.regulated) }))
    .filter((group) => group.services.length > 0);
  if (groups.length === 0) return null;
  return (
    <section aria-label="Services offered" className="space-y-2">
      <h3 className="text-sm font-medium text-neutral-500">Services offered</h3>
      {groups.map(({ category, services }) => (
        <div key={category.id}>
          <div className="text-xs font-medium uppercase tracking-wide text-emerald-700">{category.name}</div>
          <ul className="mt-1 space-y-1">
            {services.map(({ service, subservices, other }) => (
              <li key={service.id} className="text-sm text-neutral-800">
                <span className="font-medium">{service.name}</span>
                <span className="text-neutral-500">{[...subservices.map((sub) => sub.name), ...(other ? [`Other: ${other}`] : [])].length > 0 ? ": " : ""}{[...subservices.map((sub) => sub.name), ...(other ? [`Other: ${other}`] : [])].join(" · ")}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
