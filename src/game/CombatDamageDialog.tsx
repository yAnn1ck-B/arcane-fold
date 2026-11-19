import { useState, type ReactNode } from "react";
import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TableDialog } from "./TableDialog";
import type { ForgeDamageAssignment, ForgeDamageRecipient } from "./forge-match";
import "./combat-damage.css";

export function CombatDamageDialog({
  assignment,
  sourceName,
  open,
  locked,
  error,
  onClose,
  onChoose,
  recipientName,
  renderRecipient,
}: {
  assignment: ForgeDamageAssignment;
  sourceName: string;
  open: boolean;
  locked: boolean;
  error?: ReactNode;
  onClose: () => void;
  onChoose: (id: string) => void;
  recipientName: (recipient: ForgeDamageRecipient) => string;
  renderRecipient: (recipient: ForgeDamageRecipient, name: string) => ReactNode;
}) {
  const { recipients, total, choiceId, deferId } = assignment;
  const [amounts, setAmounts] = useState(() => recipients.map(({ assigned }) => assigned));
  if (!open) return null;

  const remaining = total - amounts.reduce((sum, amount) => sum + amount, 0);
  const blockersNeedDamage = recipients.some((recipient, index) => !recipient.overflow && amounts[index] < recipient.lethal);
  const hasOverflow = recipients.some((recipient) => recipient.overflow);
  const invalidTrample = blockersNeedDamage && recipients.some((recipient, index) => recipient.overflow && amounts[index] > 0);
  const names = recipients.map(recipientName);

  return (
    <TableDialog title="Assign combat damage" className="pt-damage-dialog"
      reportable={false} closeLabel="Close damage assignment" onClose={onClose}>
      {error}
      <p className="pt-damage-budget">
        <span className="pt-damage-source">{sourceName}</span>
        <span role="status"><strong>{remaining}</strong> of {total} remaining</span>
      </p>
      <div className="pt-damage-recipients">
        {recipients.map((recipient, index) => {
          const name = names[index];
          const duplicates = names.filter((other) => other === name);
          const label = duplicates.length > 1
            ? `${name} ${names.slice(0, index + 1).filter((other) => other === name).length}`
            : name;
          const amount = amounts[index];
          const maximum = amount + (recipient.overflow && blockersNeedDamage ? 0 : remaining);
          function assign(value: number) {
            const next = Number.isFinite(value) ? Math.min(maximum, Math.max(0, Math.trunc(value))) : 0;
            setAmounts((previous) => previous.map((current, i) => i === index ? next : current));
          }
          return (
            <div className="pt-damage-recipient" key={recipient.overflow ? "overflow" : recipient.cardId ?? recipient.seat ?? index}>
              {renderRecipient(recipient, label)}
              <div className="pt-damage-amount">
                <Button type="button" variant="outline" size="icon" aria-label={`Assign one less to ${label}`}
                  disabled={locked || amount === 0} onClick={() => assign(amount - 1)}>
                  <Minus size={16} aria-hidden="true" />
                </Button>
                <input type="number" inputMode="numeric" min={0} max={maximum} step={1}
                  aria-label={`Damage to ${label}`} value={amount} disabled={locked}
                  onChange={(event) => assign(event.currentTarget.valueAsNumber)} />
                <Button type="button" variant="outline" size="icon" aria-label={`Assign one more to ${label}`}
                  disabled={locked || amount >= maximum} onClick={() => assign(amount + 1)}>
                  <Plus size={16} aria-hidden="true" />
                </Button>
              </div>
            </div>
          );
        })}
      </div>
      {hasOverflow && blockersNeedDamage && <p className="pt-damage-note">Assign lethal damage to each blocker before assigning trample damage.</p>}
      <footer className="pt-damage-actions">
        {deferId && (
          <Button type="button" variant="outline" disabled={locked} onClick={() => onChoose(deferId)}>
            Assign another attacker first
          </Button>
        )}
        <Button type="button" disabled={locked || remaining !== 0 || invalidTrample}
          onClick={() => onChoose(`${choiceId}|${amounts.join(",")}`)}>
          Confirm damage
        </Button>
      </footer>
    </TableDialog>
  );
}
