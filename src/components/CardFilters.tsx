import "@/styles/card-browser.css";
import { useEffect, useId, useRef, useState } from "react";
import { LoaderCircle, Search, SlidersHorizontal, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { defaultCardQuery, searchCreatureTypes } from "@/services/cards";
import type { CardFilterOptions, CardQuery } from "@/lib/types";

interface CardFiltersProps {
  query: CardQuery;
  onChange: (query: CardQuery) => void;
  options: CardFilterOptions;
  loading?: boolean;
  advancedCollapsible?: boolean;
}

/** Facets use the whole eligible pool, so selecting a filter never hides other choices. */
export function getCardFilterScope(query: CardQuery): CardQuery {
  return {
    ...defaultCardQuery,
    ownedOnly: query.ownedOnly,
    includeBasicLands: query.includeBasicLands,
    groupByOracle: query.groupByOracle,
    availableOnly: query.availableOnly,
    allocated: query.allocated,
  };
}

const colorNames: Record<string, string> = {
  W: "White",
  U: "Blue",
  B: "Black",
  R: "Red",
  G: "Green",
  C: "Colorless",
  M: "Multicolor",
};
const colorOrder = ["W", "U", "B", "R", "G", "C", "M"];

export default function CardFilters({
  query,
  onChange,
  options,
  loading = false,
  advancedCollapsible = false,
}: CardFiltersProps) {
  const [advanced, setAdvanced] = useState(!advancedCollapsible);
  const [creatureSearch, setCreatureSearch] = useState(
    query.creatureType ?? "",
  );
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggestionLoading, setSuggestionLoading] = useState(false);
  const [suggestionError, setSuggestionError] = useState(false);
  const [focused, setFocused] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const combo = useRef<HTMLDivElement>(null);
  const listId = useId();
  const advancedId = useId();
  const colors = query.colors ?? [];
  const manaValues = query.manaValues ?? [];
  const availableMana = [...new Set(options.manaValues)].sort((a, b) => a - b);
  const lowerMana = availableMana.filter((value) => value < 6);
  const higherMana = availableMana.filter((value) => value >= 6);
  const highSelected =
    higherMana.length > 0 &&
    higherMana.every((value) => manaValues.includes(value));
  const showSuggestions =
    focused &&
    creatureSearch.trim().length >= 2 &&
    creatureSearch !== (query.creatureType ?? "");

  function update(patch: Partial<CardQuery>) {
    onChange({
      ...query,
      ...patch,
      color: "",
      manaValue: "",
      typeLine: "",
      page: 0,
    });
  }

  useEffect(() => {
    setCreatureSearch(query.creatureType ?? "");
  }, [query.creatureType, query.ownedOnly]);

  useEffect(() => {
    if (
      !focused ||
      creatureSearch.trim().length < 2 ||
      creatureSearch === (query.creatureType ?? "")
    ) {
      setSuggestions([]);
      setSuggestionLoading(false);
      return;
    }
    let active = true;
    setSuggestionLoading(true);
    setSuggestionError(false);
    setActiveSuggestion(-1);
    const timer = window.setTimeout(() => {
      searchCreatureTypes(getCardFilterScope(query), creatureSearch.trim())
        .then((items) => {
          if (active) setSuggestions(items);
        })
        .catch(() => {
          if (active) {
            setSuggestions([]);
            setSuggestionError(true);
          }
        })
        .finally(() => {
          if (active) setSuggestionLoading(false);
        });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [
    creatureSearch,
    focused,
    query.ownedOnly,
    query.includeBasicLands,
    query.availableOnly,
    query.allocated,
    query.creatureType,
  ]);

  function selectCreature(value: string) {
    setCreatureSearch(value);
    setFocused(false);
    update({ creatureType: value });
  }

  const hasFilters = Boolean(
    query.search ||
    colors.length ||
    manaValues.length ||
    query.rarity ||
    query.setCode ||
    query.cardTypes?.length ||
    query.creatureType ||
    query.minOwned,
  );

  return (
    <section className="card-browser-filters panel" aria-label="Card filters">
      <div className="card-filter-search-row">
        <div className="search-field card-browser-search">
          <Search size={16} />
          <Input
            aria-label="Search card names or abilities"
            placeholder="Search names or abilities..."
            value={query.search}
            onChange={(event) => update({ search: event.target.value })}
          />
        </div>
        {advancedCollapsible && (
          <Button
            variant="outline"
            size="icon"
            className="card-filter-advanced-toggle"
            aria-label="Advanced filters"
            data-hint="Advanced filters"
            onClick={() => setAdvanced(!advanced)}
            aria-expanded={advanced}
            aria-controls={advancedId}
          >
            <SlidersHorizontal size={16} aria-hidden="true" />
          </Button>
        )}
        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setCreatureSearch("");
              onChange({
                ...getCardFilterScope(query),
                page: 0,
                pageSize: query.pageSize,
              });
            }}
          >
            <X size={13} /> Clear
          </Button>
        )}
        {loading && (
          <LoaderCircle
            size={14}
            className="animate-spin muted-icon"
            aria-label="Loading filter choices"
          />
        )}
      </div>
      <div className="card-filter-core-groups">
        <div className="card-filter-pills-row">
          <span className="card-filter-label">Color</span>
          <div
            className="card-filter-pills"
            role="group"
            aria-label="Filter by colors"
          >
            {colorOrder
              .filter((color) => options.colors.includes(color))
              .map((color) => (
                <button
                  key={color}
                  type="button"
                  className={`card-filter-pill color-filter-pill ${colors.includes(color) ? "selected" : ""}`}
                  aria-pressed={colors.includes(color)}
                  aria-label={colorNames[color]}
                  data-hint={colorNames[color]}
                  onClick={() =>
                    update({
                      colors: colors.includes(color)
                        ? colors.filter((item) => item !== color)
                        : [...colors, color],
                    })
                  }
                >
                  <i
                    className={`filter-color-swatch filter-color-${color.toLowerCase()}`}
                    aria-hidden="true"
                  />
                </button>
              ))}
            {!options.colors.length && (
              <span className="card-filter-empty">No colors available</span>
            )}
          </div>
        </div>
        <div className="card-filter-pills-row">
          <span className="card-filter-label">Mana value</span>
          <div
            className="card-filter-pills"
            role="group"
            aria-label="Filter by mana values"
          >
            {lowerMana.map((value) => (
              <button
                key={value}
                type="button"
                className={`card-filter-pill mana-filter-pill ${manaValues.includes(value) ? "selected" : ""}`}
                aria-pressed={manaValues.includes(value)}
                onClick={() =>
                  update({
                    manaValues: manaValues.includes(value)
                      ? manaValues.filter((item) => item !== value)
                      : [...manaValues, value],
                  })
                }
              >
                {value}
              </button>
            ))}
            {higherMana.length > 0 && (
              <button
                type="button"
                className={`card-filter-pill mana-filter-pill ${highSelected ? "selected" : ""}`}
                aria-pressed={highSelected}
                onClick={() =>
                  update({
                    manaValues: highSelected
                      ? manaValues.filter((value) => value < 6)
                      : [...new Set([...manaValues, ...higherMana])],
                  })
                }
              >
                6+
              </button>
            )}
            {!availableMana.length && (
              <span className="card-filter-empty">
                No mana values available
              </span>
            )}
          </div>
        </div>
      </div>
      {advanced && (
        <div className="card-filter-advanced" id={advancedId}>
          <label>
            <span>Rarity</span>
            <select
              aria-label="Filter by rarity"
              value={query.rarity}
              onChange={(event) => update({ rarity: event.target.value })}
            >
              <option value="">All rarities</option>
              {options.rarities.map((rarity) => (
                <option key={rarity} value={rarity}>
                  {rarity.charAt(0).toUpperCase() + rarity.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Expansion</span>
            <select
              aria-label="Filter by expansion"
              value={query.setCode}
              onChange={(event) => update({ setCode: event.target.value })}
            >
              <option value="">All expansions</option>
              {options.sets.map((set) => (
                <option key={set.code} value={set.code}>
                  {set.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Card type</span>
            <select
              aria-label="Filter by card type"
              value={query.cardTypes?.[0] ?? ""}
              onChange={(event) =>
                update({
                  cardTypes: event.target.value ? [event.target.value] : [],
                })
              }
            >
              <option value="">All card types</option>
              {options.cardTypes.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          <div
            className="creature-type-combobox"
            ref={combo}
            onBlur={(event) => {
              if (
                !event.currentTarget.contains(
                  event.relatedTarget as Node | null,
                )
              )
                setFocused(false);
            }}
          >
            <label htmlFor={`${listId}-input`}>Creature type</label>
            <div className="creature-type-input">
              <Input
                id={`${listId}-input`}
                role="combobox"
                aria-label="Filter by creature type"
                aria-autocomplete="list"
                aria-expanded={showSuggestions}
                aria-controls={listId}
                aria-activedescendant={
                  activeSuggestion >= 0
                    ? `${listId}-${activeSuggestion}`
                    : undefined
                }
                placeholder="Type at least 2 letters"
                value={creatureSearch}
                onFocus={() => setFocused(true)}
                onChange={(event) => {
                  setCreatureSearch(event.target.value);
                  setFocused(true);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setFocused(false);
                    return;
                  }
                  if (event.key === "ArrowDown" && suggestions.length) {
                    event.preventDefault();
                    setActiveSuggestion(
                      (value) => (value + 1) % suggestions.length,
                    );
                  }
                  if (event.key === "ArrowUp" && suggestions.length) {
                    event.preventDefault();
                    setActiveSuggestion((value) =>
                      value <= 0 ? suggestions.length - 1 : value - 1,
                    );
                  }
                  if (
                    event.key === "Enter" &&
                    showSuggestions &&
                    suggestions.length
                  ) {
                    event.preventDefault();
                    selectCreature(suggestions[Math.max(0, activeSuggestion)]);
                  }
                }}
              />
              {creatureSearch && (
                <button
                  type="button"
                  aria-label="Clear creature type"
                  data-hint="Clear creature type"
                  onClick={() => selectCreature("")}
                >
                  <X size={13} />
                </button>
              )}
            </div>
            {showSuggestions && (
              <div
                className="creature-type-suggestions"
                role="listbox"
                id={listId}
              >
                {suggestionLoading ? (
                  <p role="status">Searching creature types...</p>
                ) : suggestionError ? (
                  <p role="status">Could not load creature types.</p>
                ) : !suggestions.length ? (
                  <p role="status">No matching creature types.</p>
                ) : (
                  suggestions.map((type, index) => (
                    <button
                      type="button"
                      role="option"
                      aria-selected={index === activeSuggestion}
                      id={`${listId}-${index}`}
                      key={type}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => selectCreature(type)}
                    >
                      {type}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
