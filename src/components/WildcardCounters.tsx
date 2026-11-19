import type { WildcardBalances, WildcardKind } from "@/lib/types";
import "@/styles/wildcard-counters.css";

interface WildcardCountersProps {
  balances: WildcardBalances;
  className?: string;
}

export function wildcardHint(kind: WildcardKind, count: number) {
  const name = kind === "discovery" ? "Discovery" : kind;
  const label = `${count} ${name} ${count === 1 ? "wildcard" : "wildcards"}`;
  return kind === "discovery" ? `${label}. Acquire a first copy.` : label;
}

export default function WildcardCounters({
  balances,
  className = "",
}: WildcardCountersProps) {
  return (
    <div
      className={`wildcard-counters ${className}`.trim()}
      role="group"
      aria-label="Wildcards"
    >
      <span className="wildcard-counters-label">Wildcards</span>
      {(["common", "uncommon", "rare", "mythic", "discovery"] as const).map((kind) => {
        const count = balances[kind] ?? 0;
        const hint = wildcardHint(kind, count);
        return (
          <span
            className={`wildcard-counter${kind === "discovery" ? " wildcard-counter-discovery" : ""}`}
            key={kind}
            data-hint={hint}
            role="img"
            tabIndex={0}
            aria-label={hint}
          >
            <i className={`rarity-dot rarity-${kind}`} aria-hidden="true" />
            <strong>{count}</strong>
          </span>
        );
      })}
    </div>
  );
}
