import type { User } from "./types";

export const admin: User = { id: 1, name: "Ada" };

export function makeGuest(id: number): User {
  return { id, name: "guest" };
}
