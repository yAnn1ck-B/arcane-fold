import type { ForgeMatch, ForgeSeat, PriorityStop } from "@/game/forge-match";
import type { ManualCommand, ManualState } from "@/game/remote-manual";

interface RoomSummary {
  id: string;
  status: "waiting" | "playing" | "finished";
  seat: ForgeSeat;
  seatNames: Record<ForgeSeat, string>;
  label: string;
}

export interface RoomView extends RoomSummary {
  revision: number;
  outcome: { winner: ForgeSeat | null; reason: "rules" | "concession" } | null;
  state: ForgeMatch | null;
  mode: "forge" | "manual";
  manualState: ManualState | null;
  controlVersion: number;
  undoAvailable: boolean;
  pendingRequest: RoomProposal | null;
  lastResolution?: {
    requestId: string; kind: RoomProposal["kind"]; decision: ProposalDecision;
    requester: ForgeSeat; responder: ForgeSeat; targetLabel?: string;
  } | null;
}

export type ProposalDecision = "accept" | "decline" | "cancel";
export interface RoomProposal {
  id: string;
  kind: "undo" | "manual";
  requester: ForgeSeat;
  targetRevision?: number;
  targetLabel?: string;
}

export interface RewindStep {
  revision: number; turn: number; phase: string; historyCount: number; label: string;
}
export interface RoomHistory { revision: number; steps: RewindStep[] }

export interface WebSession {
  decks: {
    id: string;
    name: string;
    unavailableReason?: string | null;
    practice?: { name: string; color: "Red" | "Green"; mainCount: number };
  }[];
  rooms: (RoomSummary & { current: boolean; paused: boolean; updatedAt: string })[];
  openRooms: { id: string; hostName: string; openedAt: string }[];
}

export type Move = { actionId: string } | { stop: PriorityStop } | { manualAction: ManualCommand };

export class RoomApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// Keep all requests from this document tied to the account it opened, including
// delayed autosaves when a different tab has since replaced the shared cookie.
let documentAccount = "";
export function bindAccount(email: string) { documentAccount = email; }

export async function roomRequest<T>(path: string, payload?: unknown, signal?: AbortSignal): Promise<T> {
  const headers = new Headers();
  if (payload !== undefined) headers.set("Content-Type", "application/json");
  const protectedRequest = !["/auth", "/login", "/local-login"].includes(path);
  if (documentAccount && protectedRequest) headers.set("X-Arcane-Account", documentAccount);
  const response = await fetch(`/api${path}`, {
    method: payload === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  if (!response.ok) {
    if (protectedRequest && response.status === 401) window.dispatchEvent(new Event("league-session-changed"));
    const problem = await response.json().catch(() => null);
    const message = problem?.error?.message ?? problem?.error ?? problem?.message;
    throw new RoomApiError(response.status, typeof message === "string" ? message : `Request failed (${response.status}).`);
  }
  return response.json();
}

export function roomPath(id: string) {
  return `/rooms/${encodeURIComponent(id)}`;
}

export function playUrl(room: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("page", "play");
  url.searchParams.delete("room");
  url.searchParams.delete("join");
  if (room) url.searchParams.set("room", room);
  return url;
}

export function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}
