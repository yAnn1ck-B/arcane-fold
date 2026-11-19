import { roomRequest } from "@/web/room-api";

export function invoke<T>(command: string, args: Record<string, unknown> = {}) {
  return roomRequest<T>(`/league/${encodeURIComponent(command)}`, args);
}
