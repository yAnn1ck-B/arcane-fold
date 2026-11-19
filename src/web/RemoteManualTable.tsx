import { CardImageSource } from "@/components/CardImage";
import { ProjectedTable } from "@/game/Table";
import type { MatchTools } from "@/game/TableBoard";
import type { GameIssueReport } from "@/game/issue-report";
import type { ManualCommand, ManualState } from "@/game/remote-manual";

interface RemoteManualProps {
  state: ManualState;
  matchTools: MatchTools;
  reportContext: { id: string; revision: number; error?: string };
  submitReport: (report: GameIssueReport) => Promise<void>;
  onAction: (action: ManualCommand) => void;
  locked: boolean;
}

export function RemoteManualTable({ state, matchTools, reportContext, submitReport, onAction, locked }: RemoteManualProps) {
  const viewer = state.view.viewer;
  const canAct = state.actor === null || state.actor === (viewer === 0 ? "player" : "opponent");
  function send(action: ManualCommand) {
    if (locked || !canAct) return;
    if (state.requiredOpening && action.type !== "keep" && action.type !== "mulligan") return;
    onAction(action);
  }
  return (
    <CardImageSource.Provider value={(card, face) => "/api/art?" + new URLSearchParams({
      name: card.name, set: card.setCode ?? "", number: card.collectorNumber ?? "", face,
    })}>
      <ProjectedTable view={state.view} viewer={viewer} matchTools={matchTools} imageCacheDir=""
        reportContext={reportContext} submitReport={submitReport} requiredOpening={state.requiredOpening}
        openingCanAct={canAct} locked={locked || !canAct} looking={state.looking}
        dispatch={action => {
          if (action.type === "shuffle" || action.type === "mulligan") send({ type: action.type, seat: action.seat });
          else send(action);
        }}
        onLook={count => send({ type: "look", count: Number.isFinite(count) ? count : "all" })}
        onShuffle={(seat, mulligan) => send({ type: mulligan ? "mulligan" : "shuffle", seat })}
      />
    </CardImageSource.Provider>
  );
}
