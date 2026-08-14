# Markdown and Obsidian

## Wiki links

Obsidian-style `[[note name]]` links resolve by file basename, not by
path. A rename breaks every incoming link until Obsidian updates the
graph.

## Front matter

YAML front matter at the top of a note carries tags, aliases and dates.
The parser reads it before the first heading.

## Callouts

`> [!NOTE]`, `> [!WARNING]` and `> [!TIP]` render as styled boxes in
Obsidian and degrade to plain blockquotes everywhere else.
