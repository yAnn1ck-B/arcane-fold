import { useState } from "react";
import { Droplet, Minus, Plus } from "lucide-react";
import { TableDialog } from "./TableDialog";
import { manaTypes, type Mana } from "./types";

export const manaNames: Record<Mana, string> = {
  W: "White", U: "Blue", B: "Black", R: "Red", G: "Green", C: "Colorless",
};

export function ManaPip({ color }: { color: Mana }) {
  return <span className={`ptc-pip ptc-pip-${color}`} aria-hidden>{color}</span>;
}

// The manual table lets its controller record the amount and color an ability produced.
export function TapForMana({
  name, className, basicColor, colors = manaTypes, onTap,
}: {
  name: string;
  className: string;
  basicColor?: Mana;
  colors?: readonly Mana[];
  onTap: (color: Mana, count: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState("1");
  const amount = Number(count);
  return (
    <>
      <button
        type="button"
        className={className}
        aria-label={`Tap ${name} for ${basicColor ? manaNames[basicColor].toLowerCase() + " mana" : "mana"}`}
        onClick={() => {
          if (basicColor) onTap(basicColor, 1);
          else {
            setCount("1");
            setOpen(true);
          }
        }}
      >
        {basicColor ? <>Tap <ManaPip color={basicColor} /></> : "Tap for mana"}
      </button>
      {open && (
        <TableDialog title={`Tap ${name} for mana`} reportable={false} onClose={() => setOpen(false)} className="pt-mana-dialog">
          <label className="pt-mana-amount">Amount <input type="number" min="1" step="1" value={count} onChange={event => setCount(event.target.value)} /></label>
          <div className="pt-mana-colors">
            {colors.map(color => (
              <button
                key={color} type="button" className="pt-btn"
                disabled={!Number.isSafeInteger(amount) || amount < 1}
                onClick={() => { onTap(color, amount); setOpen(false); }}
              >
                <ManaPip color={color} /> {manaNames[color]}
              </button>
            ))}
          </div>
        </TableDialog>
      )}
    </>
  );
}

export function ManaPool({
  playerName, amounts, total, onChange, onClear,
}: {
  playerName: string;
  amounts?: Record<Mana, number>;
  total: number;
  onChange?: (color: Mana, delta: number) => void;
  onClear?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const title = `${playerName}'s mana pool`;
  return (
    <>
      <button
        type="button"
        className="pt-zone-chip"
        aria-haspopup="dialog"
        aria-label={`${title}, ${total} mana`}
        data-hint={`${title}, ${total} mana`}
        onClick={() => setOpen(true)}
      >
        <Droplet size={14} aria-hidden /> <b>{total}</b>
      </button>
      {open && (
        <TableDialog title={`${playerName}’s mana pool`} reportable={false} onClose={() => setOpen(false)} className="pt-mana-dialog">
          {amounts || total === 0 ? (
            <ul className="pt-mana-balances">
              {manaTypes.map((color) => (
                <li key={color}>
                  <ManaPip color={color} />
                  <span>{manaNames[color]}</span>
                  <b>{amounts?.[color] ?? 0}</b>
                  {onChange && (
                    <>
                      <button type="button" aria-label={`Spend ${manaNames[color].toLowerCase()} mana`} disabled={!amounts?.[color]} onClick={() => onChange(color, -1)}><Minus size={14} /></button>
                      <button type="button" aria-label={`Add ${manaNames[color].toLowerCase()} mana`} onClick={() => onChange(color, 1)}><Plus size={14} /></button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          ) : <p>{total} mana. This match has no color breakdown.</p>}
          {onClear && <button type="button" disabled={!total} onClick={onClear}>Clear pool</button>}
        </TableDialog>
      )}
    </>
  );
}
