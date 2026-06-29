// LLM tiers for artist extraction, served via OpenRouter (see server/api/openrouter.js).
// PRIMARY is the cheap fast pass; FALLBACK is the stronger model the extractor
// retries with when the primary looks under-extracted (looksUnderExtracted).
// Chosen by the bake-off in scripts/bakeoff.mjs over real lineup samples.
export const PRIMARY = 'mistralai/mistral-nemo';
export const FALLBACK = 'xiaomi/mimo-v2.5-pro';
export const ALLOWED_MODELS = [PRIMARY, FALLBACK];
