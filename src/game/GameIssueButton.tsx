import { createContext, useContext } from "react";
import { Flag } from "lucide-react";

export const IssueCaptureContext = createContext<((button: HTMLButtonElement) => void) | null>(null);

export function GameIssueButton() {
  const open = useContext(IssueCaptureContext);
  if (!open) return null;
  return <button type="button" className="pt-tool" aria-label="Report game issue" data-hint="Report game issue"
    onClick={(event) => open(event.currentTarget)}><Flag size={16} aria-hidden /></button>;
}
