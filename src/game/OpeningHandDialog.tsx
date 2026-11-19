import { useState, type ReactNode } from "react";
import { Shuffle } from "lucide-react";
import { TableDialog } from "./TableDialog";
import type { ForgeChoice } from "./forge-match";
import "./opening-hand.css";

export function OpeningHandDialog({
  playerName,
  hand,
  prompt,
  actions,
  required = true,
  allowTable = false,
  error,
}: {
  playerName: string;
  hand?: ReactNode;
  prompt?: string;
  actions: ReactNode;
  required?: boolean;
  allowTable?: boolean;
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
      title={`${playerName}’s opening hand`}
      className="pt-opening-dialog"
      reportable={false}
      closeLabel="View battlefield"
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
    </TableDialog>
  );
}

export function ForgeOpeningHand({
  playerName,
  prompt,
  hand,
  choices,
  onChoose,
  locked,
  error,
  allowTable,
}: {
  playerName: string;
  prompt: string;
  hand: ReactNode;
  choices: ForgeChoice[];
  onChoose: (choice: ForgeChoice) => void;
  locked: boolean;
  error?: ReactNode;
  allowTable?: boolean;
}) {
  return (
    <OpeningHandDialog
      playerName={playerName}
      hand={hand}
      prompt={prompt}
      error={error}
      allowTable={allowTable}
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
