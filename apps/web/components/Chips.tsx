// Label and priority chips, shared by the board cards and the card panel.

const LABEL_STYLES: Record<string, string> = {
  bug: "bg-red-50 text-red-700 ring-red-200",
  feature: "bg-sky-50 text-sky-700 ring-sky-200",
  docs: "bg-amber-50 text-amber-800 ring-amber-200",
  chore: "bg-zinc-100 text-zinc-700 ring-zinc-200",
  test: "bg-emerald-50 text-emerald-700 ring-emerald-200",
};
const PRIORITY_STYLES: Record<string, string> = {
  urgent: "bg-red-600 text-white ring-red-600",
  high: "bg-orange-100 text-orange-800 ring-orange-200",
  medium: "bg-yellow-50 text-yellow-800 ring-yellow-200",
  low: "bg-zinc-50 text-zinc-600 ring-zinc-200",
};

const base = "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium leading-4 ring-1 ring-inset";

export function LabelChip({ label }: { label: string }) {
  return <span className={`${base} ${LABEL_STYLES[label] ?? LABEL_STYLES.chore}`}>{label}</span>;
}

export function PriorityChip({ priority }: { priority: string }) {
  return <span className={`${base} ${PRIORITY_STYLES[priority] ?? PRIORITY_STYLES.low}`}>{priority}</span>;
}
