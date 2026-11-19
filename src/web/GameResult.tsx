import { ArrowLeft, Flag, Heart, Layers, Scale, Swords, Trophy } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { RoomView } from "./room-api";
import "./game-result.css";

export function GameResult({ room, onLobby, onReview }: {
  room: RoomView; onLobby: () => void; onReview: () => void;
}) {
  const { outcome, seatNames, seat, state, manualState } = room;
  const other = seat === "player" ? "opponent" : "player";
  const turn = state?.turn ?? manualState?.turn;
  const winner = outcome?.winner;
  const title = !outcome ? "Game finished" : winner === null ? "Draw" : winner === seat ? "Victory" : "Defeat";
  const tone = winner ? (winner === seat ? "win" : "loss") : "neutral";
  const Icon = !outcome ? Swords : !winner ? Scale : winner === seat ? Trophy : Flag;
  let detail = room.label;
  if (outcome && !winner) detail = `${seatNames.player} and ${seatNames.opponent} drew the game.`;
  if (winner) {
    const loser = winner === "player" ? "opponent" : "player";
    detail = outcome?.reason === "concession"
      ? `${seatNames[loser]} conceded the game.` : `${seatNames[winner]} defeated ${seatNames[loser]}.`;
  }
  return (
    <section className="web-result" data-tone={tone} aria-labelledby="game-result-heading">
      <div className="web-result-banner">
        <div className="web-result-copy" role="status">
          {turn !== undefined && <p className="web-result-turn">{turn > 0 ? `Turn ${turn}` : "Opening hands"}</p>}
          <h2 id="game-result-heading">{title}</h2>
          <p className="web-result-detail">{detail}</p>
        </div>
        <div className="web-result-emblem" aria-hidden="true">
          <div className="web-result-seal"><Icon size={54} strokeWidth={1.25} /></div>
        </div>
      </div>
      <div className="web-result-body">
        <h3>Final life totals</h3>
        <dl className="web-result-scores">
          {([seat, other] as const).map((side) => {
            const life = state?.players[side].life ?? manualState?.view.players[side === "player" ? 0 : 1].life;
            return <div key={side} className="web-result-score">
              <dt><strong>{seatNames[side]}</strong></dt>
              <dd><Heart size={16} aria-hidden />{life ?? "—"}</dd>
            </div>;
          })}
        </dl>
        <div className="web-result-actions">
          <Button onClick={onLobby}><ArrowLeft size={16} aria-hidden />Return to lobby</Button>
          <Button variant="outline" onClick={onReview}><Layers size={16} aria-hidden />Review final battlefield</Button>
        </div>
      </div>
    </section>
  );
}
