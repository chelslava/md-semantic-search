# Model cache

## Where models are stored

Weights are cached under `~/.cache/mdss` (override with `MDSS_CACHE_DIR`).
The layout is a Transformers.js FileCache: one directory per model id,
with a revision subdirectory for pinned ids.

## First run downloads

The first embed downloads the quantized weights (~280 MB for e5-base).
After that the tool works fully offline. Delete the cache to force a
clean redownload of a corrupted model.

## Checking the cache

`mdss check` validates the model cache layout without loading the model:
a missing cache is a warning, and a hard failure under `--offline`.
