import { formatMana } from "@/lib/mana";
import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Library,
  LoaderCircle,
  Plus,
} from "lucide-react";
import CardImage from "@/components/CardImage";
import CardDetails from "@/components/CardDetails";
import { isUnlimitedBasic } from "@/lib/cards";
import { Button } from "@/components/ui/button";
import CardFilters, { getCardFilterScope } from "@/components/CardFilters";
import {
  defaultCardQuery,
  getCardFilterOptions,
  queryCards,
} from "@/services/cards";
import "@/styles/card-browser.css";
import type {
  AppSettings,
  CardQuery,
  CatalogCard,
  CardFilterOptions,
  LeagueStatus,
} from "@/lib/types";

interface CollectionProps {
  settings: AppSettings;
  revision: number;
  onChange: () => void;
  league: LeagueStatus;
  catalogCount: number;
  onSettings: () => void;
  onAddToDeck?: (card: CatalogCard) => void;
}

export default function Collection({
  settings,
  revision,
  onChange,
  league,
  catalogCount,
  onSettings,
  onAddToDeck,
}: CollectionProps) {
  const [query, setQuery] = useState<CardQuery>({
    ...defaultCardQuery,
    ownedOnly: true,
    groupByOracle: true,
    includeBasicLands: true,
  });
  const [cards, setCards] = useState<CatalogCard[]>([]);
  const [total, setTotal] = useState(0);
  const countsRequest = useRef<{
    revision: number;
    request: Promise<{ owned: number; all: number }>;
  } | null>(null);
  const [viewCounts, setViewCounts] = useState<{
    owned: number | null;
    all: number | null;
  }>({ owned: null, all: null });
  const [options, setOptions] = useState<CardFilterOptions>({
    colors: [],
    manaValues: [],
    rarities: [],
    sets: [],
    cardTypes: [],
  });
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<CatalogCard | null>(null);

  useEffect(() => {
    let active = true;
    if (countsRequest.current?.revision !== revision) {
      const scope = {
        ...defaultCardQuery,
        groupByOracle: true,
        includeBasicLands: true,
        pageSize: 1,
      };
      countsRequest.current = {
        revision,
        request: Promise.all([
          queryCards({ ...scope, ownedOnly: true }),
          queryCards({ ...scope, ownedOnly: false }),
        ]).then(([owned, all]) => ({ owned: owned.total, all: all.total })),
      };
    }
    void countsRequest.current.request
      .then((counts) => {
        if (active) setViewCounts(counts);
      })
      .catch((reason: unknown) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, [revision]);

  useEffect(() => {
    let active = true;
    setOptionsLoading(true);
    getCardFilterOptions(getCardFilterScope(query))
      .then((data) => {
        if (active) setOptions(data);
      })
      .catch((err: unknown) => {
        if (active) setError(String(err));
      })
      .finally(() => {
        if (active) setOptionsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [revision, query.ownedOnly]);
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

  function changeView(ownedOnly: boolean) {
    setQuery({
      ...defaultCardQuery,
      ownedOnly,
      groupByOracle: true,
      includeBasicLands: true,
    });
  }
  const pages = Math.max(1, Math.ceil(total / query.pageSize));
  const hasActiveFilters = Boolean(
    query.search ||
    query.colors.length ||
    query.manaValues.length ||
    query.rarity ||
    query.setCode ||
    query.cardTypes.length ||
    query.creatureType,
  );

  return (
    <div className="collection-page">
      <div className="collection-toolbar collection-summary panel">
        <div className="segmented-control" aria-label="Collection view">
          <button
            className={query.ownedOnly ? "active" : ""}
            onClick={() => changeView(true)}
          >
            Owned cards{" "}
            <span className="collection-view-count">
              {viewCounts.owned === null
                ? "..."
                : viewCounts.owned.toLocaleString()}
            </span>
          </button>
          <button
            className={!query.ownedOnly ? "active" : ""}
            onClick={() => changeView(false)}
          >
            All cards{" "}
            <span className="collection-view-count">
              {viewCounts.all === null
                ? "..."
                : viewCounts.all.toLocaleString()}
            </span>
          </button>
        </div>
        <div
          className="collection-toolbar-wildcards"
          role="group"
          aria-label="Wildcards"
        >
          {(["common", "uncommon", "rare", "mythic"] as const).map((rarity) => (
            <span
              className="collection-wildcard-balance"
              key={rarity}
              title={`${league.wildcards[rarity]} ${rarity} wildcards`}
              aria-label={`${league.wildcards[rarity]} ${rarity} wildcards`}
            >
              <i className={`rarity-dot rarity-${rarity}`} aria-hidden="true" />
              <strong>{league.wildcards[rarity]}</strong>
            </span>
          ))}
        </div>
      </div>
      <CardFilters
        query={query}
        onChange={setQuery}
        options={options}
        loading={optionsLoading}
      />
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
              : query.ownedOnly && !hasActiveFilters
                ? "Your collection is waiting."
                : "No cards match these filters."}
          </h2>
          <p>
            {!catalogCount
              ? "Your card catalog is being prepared automatically. Check the Forge folders in Settings if setup cannot finish."
              : query.ownedOnly && !hasActiveFilters
                ? "Open booster packs or craft cards with wildcards to grow your collection."
                : "Try another name or ability, color, expansion, or mana value."}
          </p>
          {!catalogCount && (
            <Button variant="outline" onClick={onSettings}>
              Open Settings
            </Button>
          )}
          {query.ownedOnly && catalogCount > 0 && (
            <Button variant="outline" onClick={() => changeView(false)}>
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
                <div className="collection-card-type">
                  <span>{card.typeLine.split(/\s+[\u2014\u2013]\s+/)[0]}</span>
                  <span className="card-mana">{formatMana(card.manaCost)}</span>
                </div>
                <div className="collection-card-actions">
                  <span className="collection-owned-count">
                    {isUnlimitedBasic(card) &&
                    league.enabledSets.some(
                      (code) =>
                        code.toLowerCase() === card.setCode.toLowerCase(),
                    )
                      ? "Unlimited basic land"
                      : `${card.oracleOwned ?? card.owned} owned`}
                  </span>
                  {onAddToDeck &&
                    ((card.oracleOwned ?? card.owned) > 0 ||
                      (isUnlimitedBasic(card) &&
                        league.enabledSets.some(
                          (code) =>
                            code.toLowerCase() === card.setCode.toLowerCase(),
                        ))) && (
                      <button
                        type="button"
                        className="collection-add-deck"
                        onClick={() => onAddToDeck(card)}
                        aria-label={`Add ${card.name} to a deck`}
                      >
                        <Plus size={13} /> Add to deck
                      </button>
                    )}
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
          onAddToDeck={
            onAddToDeck
              ? (card) => {
                  setSelected(null);
                  onAddToDeck(card);
                }
              : undefined
          }
        />
      )}
    </div>
  );
}
