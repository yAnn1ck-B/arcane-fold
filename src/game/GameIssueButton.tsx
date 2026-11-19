import { createContext, useContext } from "react";
import { Bug } from "lucide-react";

export const IssueCaptureContext = createContext<((button: HTMLButtonElement) => void) | null>(null);

export function GameIssueButton({ showLabel = false }: { showLabel?: boolean }) {
  const open = useContext(IssueCaptureContext);
  if (!open) return null;
  return <button type="button" className="pt-tool" aria-label="Report game issue" data-hint={showLabel ? undefined : "Report game issue"}
    onClick={(event) => open(event.currentTarget)}><Bug size={16} aria-hidden />{showLabel && "Report game issue"}</button>;
}
