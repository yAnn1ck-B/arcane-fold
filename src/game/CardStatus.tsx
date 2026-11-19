import { Ban, Droplet, Hourglass, Layers2, Orbit, Sparkles } from "lucide-react";

interface CardState {
  summoningSick?: boolean;
  phasedOut?: boolean;
  damage?: number;
  grantedKeywords?: string[];
  cantAttack?: boolean;
  cantBlock?: boolean;
  counters?: Record<string, number>;
}

export interface CardStatusInfo {
  kind: "sickness" | "phased" | "counter" | "damage" | "ability" | "restriction";
  short: string;
  label: string;
  detail?: string;
}

export function cardStatuses(card: CardState): CardStatusInfo[] {
  const statuses: CardStatusInfo[] = [];
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

export function CardStatus({ statuses }: { statuses: CardStatusInfo[] }) {
  if (!statuses.length) return null;
  const first = statuses[0];
  const Icon = icons[first.kind];
  return (
    <div className="pt-card-status" data-kind={first.kind} aria-hidden="true">
      <Icon size={12} aria-hidden /><span>{first.short}</span>
      {statuses.length > 1 && <b>+{statuses.length - 1}</b>}
    </div>
  );
}
