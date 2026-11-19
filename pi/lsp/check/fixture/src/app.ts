export function total(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

// Planted type error for the LSP test: a number is not a string.
export const label: string = total([1, 2, 3]);
