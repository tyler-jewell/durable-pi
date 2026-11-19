import { formatPrice } from "./money";

export const line = (name: string, cents: number): string => `${name}: ${formatPrice(cents)}`;
