import { useState, type ReactNode } from "react";
import { Shuffle } from "lucide-react";
import { TableDialog } from "./TableDialog";
import type { ForgeChoice, ForgeSeat } from "./forge-match";
import "./opening-hand.css";

export function OpeningHandDialog({
  player,
  hand,
  prompt,
  actions,
  required = true,
  allowTable = false,
  tools,
  error,
}: {
  player: number;
  hand?: ReactNode;
  prompt?: string;
  actions: ReactNode;
  required?: boolean;
  allowTable?: boolean;
  tools?: ReactNode;
  error?: ReactNode;
}) {
  const [open, setOpen] = useState<boolean | undefined>(undefined);
  const canClose = !required || allowTable;
  if (canClose && !(open ?? required)) {
    return (
      <button
        type="button"
        className="pt-btn pt-primary"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        View opening hand
      </button>
    );
  }
  return (
    <TableDialog
      title="Opening hand"
      subtitle={`Player ${player}`}
      className="pt-opening-dialog"
      closeLabel="View table"
      onClose={canClose ? () => setOpen(false) : undefined}
    >
      {error}
      {prompt && (
        <p className="pt-opening-prompt" role="status">
          {prompt}
        </p>
      )}
      {hand && <div className="pt-opening-cards">{hand}</div>}
      <div className="pt-opening-actions">{actions}</div>
      {tools}
    </TableDialog>
  );
}

export function ForgeOpeningHand({
  seat,
  prompt,
  hand,
  choices,
  onChoose,
  locked,
  error,
  allowTable,
  tools,
}: {
  seat: ForgeSeat;
  prompt: string;
  hand: ReactNode;
  choices: ForgeChoice[];
  onChoose: (choice: ForgeChoice) => void;
  locked: boolean;
  error?: ReactNode;
  allowTable?: boolean;
  tools?: ReactNode;
}) {
  return (
    <OpeningHandDialog
      player={seat === "player" ? 1 : 2}
      hand={hand}
      prompt={prompt}
      error={error}
      allowTable={allowTable}
      tools={tools}
      actions={
        <>
          {choices.map((choice) => (
            <button
              type="button"
              key={choice.id}
              className={choice.label === "Keep hand" ? "pt-btn pt-primary" : "pt-btn"}
              disabled={locked}
              onClick={() => onChoose(choice)}
            >
              {choice.label === "Mulligan" && <Shuffle size={15} aria-hidden />}
              {choice.label}
            </button>
          ))}
        </>
      }
    />
  );
}
