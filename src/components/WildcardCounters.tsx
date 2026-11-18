import type { WildcardBalances } from "@/lib/types";
import "@/styles/wildcard-counters.css";

interface WildcardCountersProps {
  balances: WildcardBalances;
  className?: string;
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
      {(["common", "uncommon", "rare", "mythic"] as const).map((rarity) => (
        <span
          className="wildcard-counter"
          key={rarity}
          title={`${balances[rarity]} ${rarity} wildcards`}
          aria-label={`${balances[rarity]} ${rarity} wildcards`}
        >
          <i className={`rarity-dot rarity-${rarity}`} aria-hidden="true" />
          <strong>{balances[rarity]}</strong>
        </span>
      ))}
      <span
        className="wildcard-counter wildcard-counter-discovery"
        title={`${balances.discovery ?? 0} Discovery wildcards — acquire a first copy`}
        aria-label={`${balances.discovery ?? 0} Discovery wildcards`}
      >
        <i className="rarity-dot rarity-discovery" aria-hidden="true" />
        <strong>{balances.discovery ?? 0}</strong>
      </span>
    </div>
  );
}
