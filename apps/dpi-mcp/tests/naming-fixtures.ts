// The one place the test suite spells a model-naming convention: a quantization suffix and the catalog namespace.
// Parser tests need the convention, so it is written here once, and the zero-names guard exempts this file only.
// Every other fixture is generic.
export const QUANT = "-Q4_K_M";
export const CF_NAMESPACE = "@cf/";
