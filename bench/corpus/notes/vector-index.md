# Vector index

## Rebuilding the index

The index is stored under `<db>/.mdss`. A rebuild is incremental: files
whose md5 is unchanged are skipped, and inside a changed file only the
edited sections are re-embedded.

## When a full rebuild happens

Switching the embedding model invalidates stored vectors, so the next
index run re-embeds everything. A schema or adapter change has the same
effect. Indexes written by a newer mdss version are rejected with a
clear upgrade error.

## Checkpointing

Long builds checkpoint progress every eight embedding batches. After an
interruption the next build resumes from the checkpoint.
