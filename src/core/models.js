// LLM tiers for artist extraction, served via OpenRouter (see server/api/openrouter.js).
// PRIMARY is the cheap fast pass; FALLBACK is the stronger model the extractor
// retries with when the primary looks under-extracted (looksUnderExtracted).
// Chosen by the bake-off in scripts/bakeoff.mjs over real lineup samples — incl.
// large/noisy reader-page captures (tests/fixtures/extract). The prior primary
// (mistralai/mistral-nemo) collapsed on big pages — ~25 of 65 acts on a 101k page,
// padding the gap with hallucinated record labels — so qwen3-30b (full big-page
// recall, ~12x cheaper than the fallback) took over as primary.
export const PRIMARY = 'qwen/qwen3-30b-a3b-instruct-2507';
export const FALLBACK = 'xiaomi/mimo-v2.5-pro';
export const ALLOWED_MODELS = [PRIMARY, FALLBACK];
