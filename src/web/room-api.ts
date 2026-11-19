import type { ForgeMatch, ForgeSeat, PriorityStop } from "@/game/forge-match";

interface RoomSummary {
  id: string;
  status: "waiting" | "playing" | "finished";
  seat: ForgeSeat;
  label: string;
  inviteCode?: string;
}

export interface RoomView extends RoomSummary {
  revision: number;
  state: ForgeMatch | null;
}

export interface WebSession {
  decks: { id: string; name: string }[];
  rooms: RoomSummary[];
}

export type Move = { actionId: string } | { stop: PriorityStop };

export class RoomApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function roomRequest<T>(path: string, payload?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: payload === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers: payload === undefined ? undefined : { "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => null);
    const message = problem?.error?.message ?? problem?.error ?? problem?.message;
    throw new RoomApiError(response.status, typeof message === "string" ? message : `Request failed (${response.status}).`);
  }
  return response.json();
}

// Starting two anonymous sessions concurrently can leave the UI with a view
// for a different cookie. Coalesce startup requests across React remounts.
let pendingSession: Promise<WebSession> | undefined;
export function readSession() {
  if (!pendingSession) {
    pendingSession = roomRequest<WebSession>("/session").finally(() => { pendingSession = undefined; });
  }
  return pendingSession;
}

export function roomPath(id: string) {
  return `/rooms/${encodeURIComponent(id)}`;
}

export function playUrl(room: string, join = "") {
  const url = new URL(window.location.href);
  url.searchParams.set("page", "play");
  url.searchParams.delete("room");
  url.searchParams.delete("join");
  if (room) url.searchParams.set("room", room);
  if (join) url.searchParams.set("join", join);
  return url;
}

export function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}
