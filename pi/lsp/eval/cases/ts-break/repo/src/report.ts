import { admin, makeGuest } from "./users";

export const lines = [admin, makeGuest(2)].map((u) => `${u.name} <${u.email}>`);
