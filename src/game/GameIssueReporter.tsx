import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { version } from "../../package.json";
import { GameIssueButton, IssueCaptureContext } from "./GameIssueButton";
import { TableDialog } from "./TableDialog";
import { freezeGameIssue, type GameIssueReport, type IssueAction, type IssuePosition } from "./issue-report";

type ReportingProps = {
  capture: () => IssuePosition;
  submit?: (report: GameIssueReport) => Promise<void>;
};

async function saveDesktopReport(report: GameIssueReport) {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("save_game_issue", { report });
}

function visibleControls(container: Element | null): IssueAction[] {
  if (!container) return [];
  const controls = container.querySelectorAll<HTMLElement>("button, [role=button], input, select, summary");
  return Array.from(controls).flatMap((control) => {
    if (!control.getClientRects().length) return [];
    const label = control.getAttribute("aria-label") ?? control.getAttribute("data-hint")
      ?? control.innerText.trim();
    return label && label !== "Report game issue" ? [{ label, disabled: control.matches(":disabled, [aria-disabled=true]") }] : [];
  });
}

export function GameIssueReporting({ capture, submit = saveDesktopReport, children }: ReportingProps & { children: ReactNode }) {
  const [draft, setDraft] = useState<GameIssueReport>();
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [saved, setSaved] = useState(false);
  const pending = useRef(false);

  function open(button: HTMLButtonElement) {
    const dialog = button.closest("dialog");
    const container = dialog ?? button.closest(".pt-table, .game-page") ?? button.parentElement;
    const label = dialog?.getAttribute("aria-label") ?? dialog?.querySelector("h2")?.textContent ?? undefined;
    setDraft(freezeGameIssue(capture(), version, visibleControls(container), label));
    setNote("");
    setError("");
    setSaved(false);
  }

  async function save() {
    if (!draft || pending.current) return;
    pending.current = true;
    setWorking(true);
    setError("");
    try {
      await submit({ ...draft, expectedBehavior: note.trim() });
      setSaved(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      pending.current = false;
      setWorking(false);
    }
  }

  return <IssueCaptureContext.Provider value={open}>
    {children}
    {draft && createPortal(
      <TableDialog title={saved ? "Game issue saved" : "Report game issue"} reportable={false}
        onClose={working ? undefined : () => setDraft(undefined)}>
        {saved ? <>
          <p role="status">Report saved. You can continue playing.</p>
          <div className="pt-launch"><button type="button" className="pt-btn pt-primary" onClick={() => setDraft(undefined)}>Back to game</button></div>
        </> : <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <p>Your current view, available actions and public game history will be included.</p>
          <label className="pt-issue-note">What did you expect to happen? (optional)
            <textarea rows={3} maxLength={1000} value={note} disabled={working} onChange={(event) => setNote(event.target.value)} />
          </label>
          {error && <p role="alert" className="notice notice-error">{error}</p>}
          <div className="pt-launch"><button type="submit" className="pt-btn pt-primary" disabled={working}>{working ? "Saving…" : "Save report"}</button></div>
        </form>}
      </TableDialog>, document.body)}
  </IssueCaptureContext.Provider>;
}

export function GameIssueReporter(props: ReportingProps) {
  return <GameIssueReporting {...props}><GameIssueButton /></GameIssueReporting>;
}
