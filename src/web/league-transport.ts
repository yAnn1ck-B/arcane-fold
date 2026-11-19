import { roomRequest } from "./room-api";

export const syncsToForge = false;

export function invoke<T>(command: string, args: Record<string, unknown> = {}) {
  return roomRequest<T>(`/league/${encodeURIComponent(command)}`, args);
}
