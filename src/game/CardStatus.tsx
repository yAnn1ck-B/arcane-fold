import { useState } from "react";
import { Ban, Droplet, Hourglass, Layers2, Orbit, Sparkles } from "lucide-react";
import { TableDialog } from "./TableDialog";

interface CardState {
  summoningSick?: boolean;
  phasedOut?: boolean;
  damage?: number;
  grantedKeywords?: string[];
  cantAttack?: boolean;
  cantBlock?: boolean;
  counters?: Record<string, number>;
}

interface Status {
  kind: "sickness" | "phased" | "counter" | "damage" | "ability" | "restriction";
  short: string;
  label: string;
  detail?: string;
}

export function cardStatuses(card: CardState): Status[] {
  const statuses: Status[] = [];
  if (card.phasedOut) statuses.push({
    kind: "phased", short: "Phased out", label: "Phased out",
    detail: "Most effects treat this permanent as though it doesn’t exist until it phases in.",
  });
  if (card.summoningSick) statuses.push({
    kind: "sickness", short: "Sick", label: "Summoning sickness",
    detail: "Summoning sickness prevents attacking and using abilities with a tap or untap symbol in their cost. It wears off when the controller’s next turn starts. Haste bypasses it.",
  });
  if (card.cantAttack || card.cantBlock) {
    const label = card.cantAttack && card.cantBlock ? "Can’t attack or block" : card.cantAttack ? "Can’t attack" : "Can’t block";
    statuses.push({ kind: "restriction", short: label, label });
  }
  for (const [name, count] of Object.entries(card.counters ?? {})) {
    if (count <= 0) continue;
    statuses.push({ kind: "counter", short: `${count} ${name}`,
      label: `${count} ${name} ${count === 1 ? "counter" : "counters"}`,
      detail: name.toLowerCase() === "stun" ? "If this permanent would untap, remove one stun counter instead." : undefined });
  }
  if (card.damage) statuses.push({ kind: "damage", short: `${card.damage} damage`, label: `${card.damage} damage marked` });
  for (const keyword of card.grantedKeywords ?? []) {
    statuses.push({ kind: "ability", short: keyword, label: `Granted ability · ${keyword}` });
  }
  return statuses;
}

const icons = { sickness: Hourglass, phased: Orbit, counter: Layers2, damage: Droplet, ability: Sparkles, restriction: Ban };

export function CardStatus({ name, statuses }: { name: string; statuses: Status[] }) {
  const [open, setOpen] = useState(false);
  if (!statuses.length) return null;
  const first = statuses[0];
  const Icon = icons[first.kind];
  return <>
    <button type="button" className="pt-card-status" data-kind={first.kind} aria-haspopup="dialog"
      aria-label={`${name} status: ${statuses.map(status => status.label).join(", ")}`}
      title={statuses.map(status => status.label).join(" · ")} onClick={() => setOpen(true)}>
      <Icon size={12} aria-hidden /><span>{first.short}</span>
      {statuses.length > 1 && <b>+{statuses.length - 1}</b>}
    </button>
    {open && <TableDialog title={name} label={`${name} status`} className="pt-state-dialog"
      reportable={false} onClose={() => setOpen(false)}>
      <ul className="pt-card-states">{statuses.map(status => {
        const StateIcon = icons[status.kind];
        return <li key={status.kind + status.label}><StateIcon size={17} aria-hidden />
          <div><strong>{status.label}</strong>{status.detail && <p>{status.detail}</p>}</div>
        </li>;
      })}</ul>
    </TableDialog>}
  </>;
}
