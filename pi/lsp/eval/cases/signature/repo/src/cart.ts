import { formatPrice } from "./money";

export const cartTotal = (items: number[]): string => formatPrice(items.reduce((a, b) => a + b, 0));
