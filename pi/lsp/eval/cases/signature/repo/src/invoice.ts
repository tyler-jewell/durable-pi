import { formatPrice as price } from "./money";

export const due = (cents: number): string => `Amount due ${price(cents)}`;
export const paid = (cents: number): string => `Paid ${price(cents)}`;
