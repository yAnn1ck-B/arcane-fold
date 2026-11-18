import { Heart, Layers } from "lucide-react";
import type { ReactNode } from "react";
import "./table.css";
import "./controls.css";

export function TableBoard({
  label,
  toolbar,
  seats,
  handCount,
  hand,
  stack,
  children,
}: {
  label: string;
  toolbar: ReactNode;
  seats: ReactNode;
  handCount: number;
  hand: ReactNode[];
  stack: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className="pt-table" aria-label={label}>
      <div className="pt-turnbar">{toolbar}</div>
      <div className="pt-table-layout">
        <div className="pt-arena">
          {seats}
          <section className="pt-hand" aria-label="Your hand">
            <div className="pt-zone-header">
              <h3>
                Your hand <small>{handCount}</small>
              </h3>
            </div>
            <div className="pt-field">
              {hand.length ? (
                hand
              ) : (
                <span className="pt-empty">No cards in hand</span>
              )}
            </div>
          </section>
        </div>
        <aside className="pt-stack-rail" aria-label="Shared stack">
          {stack}
        </aside>
      </div>
      {children}
    </section>
  );
}

export function TableSeat({
  own,
  label,
  title,
  piles,
  resources,
  battlefieldAction,
  battlefieldForm,
  cards,
}: {
  own: boolean;
  label: string;
  title: string;
  piles?: ReactNode;
  resources: ReactNode;
  battlefieldAction?: ReactNode;
  battlefieldForm?: ReactNode;
  cards?: ReactNode[];
}) {
  return (
    <section
      className={`pt-seat ${own ? "pt-own" : "pt-opponent"}`}
      aria-label={`${label} battlefield`}
    >
      <header className="pt-seat-heading">
        <div className="pt-seat-title">
          <span>
            {label}
            {own && " · Your seat"}
          </span>
          <h2>{title}</h2>
        </div>
        {piles && (
          <div className="pt-piles" aria-label={`${label} zones`}>
            {piles}
          </div>
        )}
      </header>
      {resources}
      <div className="pt-zone-header">
        <h3>Battlefield</h3>
        {battlefieldAction}
      </div>
      {battlefieldForm}
      <div className="pt-field">
        {cards?.length ? (
          cards
        ) : (
          <span className="pt-empty">
            <Layers size={19} />{" "}
            {cards ? "Empty battlefield" : "Battlefield unavailable"}
          </span>
        )}
      </div>
    </section>
  );
}

export function LifeValue({ life }: { life: number }) {
  return (
    <strong aria-label={`${life} life`}>
      <Heart size={15} /> {life}
    </strong>
  );
}

export function StackPanel({
  count,
  children,
}: {
  count: number;
  children: ReactNode;
}) {
  return (
    <section className="ptc ptc-stack" aria-label="Shared stack">
      <div className="ptc-row ptc-stack-title">
        <Layers size={18} />
        <h3>Stack</h3>
        <span>{count}</span>
      </div>
      {children}
    </section>
  );
}
