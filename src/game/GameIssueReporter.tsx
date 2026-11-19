import { useId, useRef, useState, type ReactNode } from "react";
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

function visibleControls(container: Element | null) {
  const items: IssueAction[] = [];
  let truncated = false;
  const controls = container?.querySelectorAll<HTMLElement>("button, [role=button], input, select, summary") ?? [];
  for (const control of controls) {
    if (!control.getClientRects().length) continue;
    const label = control.getAttribute("aria-label") ?? control.getAttribute("data-hint")
      ?? control.innerText.trim();
    if (!label || label === "Report game issue") continue;
    if (items.length === 256) { truncated = true; break; }
    truncated ||= label.length > 512;
    items.push({label: label.slice(0,512), disabled: control.matches(":disabled, [aria-disabled=true]")});
  }
  return { items, truncated };
}

export function GameIssueReporting({ capture, submit = saveDesktopReport, children }: ReportingProps & { children: ReactNode }) {
  const [draft, setDraft] = useState<GameIssueReport>();
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [saved, setSaved] = useState(false);
  const submission = useRef<GameIssueReport | null>(null);
  const pending = useRef(false);
  const noteId = useId();

  function open(button: HTMLButtonElement) {
    const dialog = button.closest("dialog");
    const container = dialog ?? button.closest(".pt-table, .game-page") ?? button.parentElement;
    const label = dialog?.getAttribute("aria-label") ?? dialog?.querySelector("h2")?.textContent ?? undefined;
    const controls = visibleControls(container);
    const report = freezeGameIssue(capture(), version, controls.items, label);
    report.visibleControlsTruncated = controls.truncated;
    setDraft(report);
    submission.current = null;
    setNote("");
    setError("");
    setSaved(false);
  }

  async function save() {
    if (!draft || pending.current || !note.trim()) return;
    pending.current = true;
    setWorking(true);
    setError("");
    try {
      submission.current ??= { ...draft, expectedBehavior: note.trim() };
      await submit(submission.current);
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
        </> : <form className="pt-issue-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <label htmlFor={noteId} className="pt-issue-label">What did you expect to happen?</label>
          <textarea id={noteId} className="ui-input" required rows={4} maxLength={1000}
            aria-describedby={noteId + "-hint"} value={note} disabled={working || submission.current !== null}
            onChange={(event) => setNote(event.target.value)} />
          <p id={noteId + "-hint"} className="pt-issue-hint">Your board, available actions and public game log are included automatically.</p>
          {error && <p role="alert" className="notice notice-error">{error}</p>}
          <div className="pt-launch"><button type="submit" className="pt-btn pt-primary" disabled={working || !note.trim()}>{working ? "Saving…" : error ? "Retry save" : "Save report"}</button></div>
        </form>}
      </TableDialog>, document.body)}
  </IssueCaptureContext.Provider>;
}

export function GameIssueReporter(props: ReportingProps) {
  return <GameIssueReporting {...props}><GameIssueButton /></GameIssueReporting>;
}
