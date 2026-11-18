import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { loadSession } from "./storage";
import { TableDialog } from "./TableDialog";

type Slot = { revision: string; title: string; turn: number } | null;

export function ManualHandoffDialog({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: (previous: string | undefined) => Promise<void>;
}) {
  const [slot, setSlot] = useState<Slot>();
  const [replace, setReplace] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);

  useEffect(() => {
    let active = true;
    void loadSession()
      .then((session) => {
        if (active)
          setSlot(
            session && {
              revision: session.saved.revision,
              title: session.match.players
                .map((player) => player.deckName)
                .join(" vs. "),
              turn: session.match.turn,
            },
          );
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
    };
  }, [attempt]);

  function refresh() {
    setSlot(undefined);
    setReplace(false);
    setAttempt((value) => value + 1);
  }

  async function confirm() {
    if (pending.current || slot === undefined || (slot && !replace)) return;
    pending.current = true;
    setSaving(true);
    setError("");
    try {
      await onConfirm(slot?.revision);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      // Re-read the slot before another attempt. Replacement consent is tied
      // to the exact checkpoint the player saw.
      refresh();
    } finally {
      pending.current = false;
      setSaving(false);
    }
  }

  return (
    <TableDialog
      title="Continue this game manually?"
      onClose={() => {
        if (!pending.current) onCancel();
      }}
    >
      <p>
        You’ll control both players and resolve all effects yourself. Once you
        switch, you can’t return this game to Forge.
      </p>
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      {slot === undefined &&
        (error ? (
          <Button
            variant="outline"
            onClick={() => {
              setError("");
              refresh();
            }}
          >
            Check saved table again
          </Button>
        ) : (
          <p role="status">Checking the manual save…</p>
        ))}
      {slot && (
        <label className="pt-replace-consent">
          <input
            type="checkbox"
            checked={replace}
            disabled={saving}
            onChange={(e) => setReplace(e.target.checked)}
          />
          Replace the saved manual game “{slot.title}” (turn {slot.turn}) and
          its undo history.
        </label>
      )}
      <div className="pt-launch">
        <Button variant="outline" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          disabled={saving || slot === undefined || (!!slot && !replace)}
          onClick={() => void confirm()}
        >
          {saving ? "Saving manual game…" : "Switch to manual play"}
        </Button>
      </div>
    </TableDialog>
  );
}
