import { formatMana } from "@/lib/mana";
import { useEffect, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Library,
  LoaderCircle,
  Search,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import CardImage from "@/components/CardImage";
import CardDetails from "@/components/CardDetails";
import { isUnlimitedBasic } from "@/lib/cards";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { defaultCardQuery, listSets, queryCards } from "@/services/cards";
import type {
  AppSettings,
  CardQuery,
  CatalogCard,
  CatalogSet,
  LeagueStatus,
} from "@/lib/types";

interface CollectionProps {
  settings: AppSettings;
  revision: number;
  onChange: () => void;
  league: LeagueStatus;
  catalogCount: number;
  onSettings: () => void;
}

export default function Collection({
  settings,
  revision,
  onChange,
  league,
  catalogCount,
  onSettings,
}: CollectionProps) {
  const [query, setQuery] = useState<CardQuery>({
    ...defaultCardQuery,
    ownedOnly: true,
  });
  const [cards, setCards] = useState<CatalogCard[]>([]);
  const [total, setTotal] = useState(0);
  const [sets, setSets] = useState<CatalogSet[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<CatalogCard | null>(null);

  useEffect(() => {
    let active = true;
    listSets()
      .then((data) => {
        if (active) setSets(data);
      })
      .catch((err: unknown) => {
        if (active) setError(String(err));
      });
    return () => {
      active = false;
    };
  }, [revision]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    const timer = setTimeout(() => {
      queryCards(query)
        .then((result) => {
          if (active) {
            setCards(result.cards);
            setTotal(result.total);
            setError(null);
            const last = Math.max(
              0,
              Math.ceil(result.total / query.pageSize) - 1,
            );
            if (query.page > last)
              setQuery((current) => ({ ...current, page: last }));
          }
        })
        .catch((err: unknown) => {
          if (active) setError(String(err));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 220);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, revision]);

  function filter<K extends keyof CardQuery>(key: K, value: CardQuery[K]) {
    setQuery((current) => ({ ...current, [key]: value, page: 0 }));
  }
  const pages = Math.max(1, Math.ceil(total / query.pageSize));

  return (
    <div className="collection-page">
      <div className="collection-wildcards">
        <span>
          <Sparkles size={15} /> Wildcards
        </span>
        {(["common", "uncommon", "rare", "mythic"] as const).map((rarity) => (
          <span key={rarity}>
            <i className={`rarity-dot rarity-${rarity}`} />{" "}
            {league.wildcards[rarity]} {rarity}
          </span>
        ))}
        <small>
          Spend one matching wildcard to add one card from an unlocked set, up
          to four copies.
        </small>
      </div>
      <div className="collection-toolbar">
        <div className="segmented-control" aria-label="Collection view">
          <button
            className={query.ownedOnly ? "active" : ""}
            onClick={() => filter("ownedOnly", true)}
          >
            Owned cards
          </button>
          <button
            className={!query.ownedOnly ? "active" : ""}
            onClick={() => filter("ownedOnly", false)}
          >
            All cards
          </button>
        </div>
        <div className="search-field">
          <Search size={16} />
          <Input
            aria-label="Search card names or abilities"
            placeholder="Search names or abilities…"
            value={query.search}
            onChange={(event) => filter("search", event.target.value)}
          />
        </div>
        <span className="result-count">{total.toLocaleString()} printings</span>
      </div>
      <div className="collection-filters panel">
        <SlidersHorizontal size={16} className="muted-icon" />
        <select
          aria-label="Filter by color"
          value={query.color}
          onChange={(e) => filter("color", e.target.value)}
        >
          <option value="">All colors</option>
          {[
            ["W", "White"],
            ["U", "Blue"],
            ["B", "Black"],
            ["R", "Red"],
            ["G", "Green"],
            ["C", "Colorless"],
            ["M", "Multicolor"],
          ].map(([id, name]) => (
            <option value={id} key={id}>
              {name}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by rarity"
          value={query.rarity}
          onChange={(e) => filter("rarity", e.target.value)}
        >
          <option value="">All rarities</option>
          {["common", "uncommon", "rare", "mythic", "special", "bonus"].map(
            (rarity) => (
              <option key={rarity} value={rarity}>
                {rarity[0].toUpperCase() + rarity.slice(1)}
              </option>
            ),
          )}
        </select>
        <select
          aria-label="Filter by expansion"
          value={query.setCode}
          onChange={(e) => filter("setCode", e.target.value)}
        >
          <option value="">All expansions</option>
          {sets.map((set) => (
            <option key={set.code} value={set.code}>
              {set.name} ({set.code.toUpperCase()})
            </option>
          ))}
        </select>
        <Input
          aria-label="Filter by card type"
          placeholder="Type, e.g. Creature"
          value={query.typeLine}
          onChange={(e) => filter("typeLine", e.target.value)}
        />
        <Input
          aria-label="Filter by mana value"
          type="number"
          min={0}
          step={0.5}
          placeholder="Mana value"
          value={query.manaValue}
          onChange={(e) => filter("manaValue", e.target.value)}
        />
        <select
          aria-label="Filter by owned quantity"
          value={query.minOwned}
          onChange={(e) => filter("minOwned", Number(e.target.value))}
        >
          <option value={0}>Any quantity</option>
          <option value={1}>1+ owned</option>
          <option value={4}>4+ owned</option>
        </select>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            setQuery({ ...defaultCardQuery, ownedOnly: query.ownedOnly })
          }
        >
          Clear filters
        </Button>
      </div>
      <p className="collection-hint">
        Open a card to view its details or craft a copy with a matching
        wildcard.
      </p>
      {error && (
        <div className="notice notice-error" role="alert">
          {error}
        </div>
      )}
      {loading && (
        <div className="results-loading" role="status">
          <LoaderCircle size={15} className="animate-spin" /> Searching your
          local catalog…
        </div>
      )}
      {!loading && !cards.length ? (
        <section className="panel collection-empty">
          <Library size={36} strokeWidth={1.2} />
          <h2>
            {!catalogCount
              ? "Your catalog is waiting."
              : query.ownedOnly
                ? "Your collection is waiting."
                : "No cards match these filters."}
          </h2>
          <p>
            {!catalogCount
              ? "Your card catalog is being prepared automatically. Check the Forge folders in Settings if setup cannot finish."
              : query.ownedOnly
                ? "Open booster packs or craft cards with wildcards to grow your collection."
                : "Try another name or ability, color, expansion, or mana value."}
          </p>
          {!catalogCount && (
            <Button variant="outline" onClick={onSettings}>
              Open Settings
            </Button>
          )}
          {query.ownedOnly && catalogCount > 0 && (
            <Button
              variant="outline"
              onClick={() =>
                setQuery({ ...defaultCardQuery, ownedOnly: false })
              }
            >
              Browse all cards
            </Button>
          )}
        </section>
      ) : (
        <div className="card-grid" aria-busy={loading}>
          {cards.map((card) => (
            <article className="collection-card" key={card.id}>
              <div className="collection-card-art">
                <CardImage
                  card={card}
                  imageCacheDir={settings.forge.imageCacheDir}
                />
                <button
                  type="button"
                  className="card-art-trigger"
                  onClick={() => setSelected(card)}
                  aria-label={`View ${card.name} details`}
                />
              </div>
              <div className="collection-card-info">
                <button
                  className="card-name"
                  onClick={() => setSelected(card)}
                  title={card.name}
                >
                  {card.name}
                </button>
                <div className="card-printing">
                  <span className={`rarity-dot rarity-${card.rarity}`} />
                  {card.setCode.toUpperCase()}{" "}
                  <span>#{card.collectorNumber}</span>
                  <span className="card-mana">{formatMana(card.manaCost)}</span>
                </div>
                <div className="quantity-control">
                  <span>
                    {isUnlimitedBasic(card)
                      ? "Unlimited basic land"
                      : `${card.owned} owned`}
                  </span>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
      {total > 0 && (
        <div className="pagination">
          <span>
            Page {query.page + 1} of {pages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={query.page === 0 || loading}
            onClick={() =>
              setQuery((current) => ({ ...current, page: current.page - 1 }))
            }
          >
            <ChevronLeft size={14} /> Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={query.page + 1 >= pages || loading}
            onClick={() =>
              setQuery((current) => ({ ...current, page: current.page + 1 }))
            }
          >
            Next <ChevronRight size={14} />
          </Button>
        </div>
      )}
      {selected && (
        <CardDetails
          card={selected}
          imageCacheDir={settings.forge.imageCacheDir}
          onClose={() => setSelected(null)}
          league={league}
          onChange={onChange}
        />
      )}
    </div>
  );
}
