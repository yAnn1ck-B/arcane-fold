import { useEffect, useRef, useState } from "react";
import { ScrollText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TableDialog } from "./TableDialog";
import type { HistoryEntry } from "./types";

export function GameHistory({ entries }: { entries: HistoryEntry[] }) {
  const [open, setOpen] = useState(false);
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (open) list.current?.lastElementChild?.scrollIntoView({ block: "end" });
  }, [open]);
  return (
    <>
      <Button
        variant="outline"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <ScrollText size={16} /> Game log
      </Button>
      {open && (
        <TableDialog
          title="Game log"
          closeLabel="Close game log"
          onClose={() => setOpen(false)}
        >
          {entries.length ? (
            <ol ref={list} className="pt-game-log">
              {entries.map((entry, index) => (
                <li key={index}>
                  {entries[index - 1]?.turn !== entry.turn && (
                    <h3>
                      {entry.turn > 0 ? `Turn ${entry.turn}` : "Opening hands"}
                    </h3>
                  )}
                  {entry.text}
                </li>
              ))}
            </ol>
          ) : (
            <p>No game actions yet.</p>
          )}
        </TableDialog>
      )}
    </>
  );
}
