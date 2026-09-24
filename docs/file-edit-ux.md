# Reviewable file changes

`edit_file`, `write_file`, and `delete_file` now produce a structured `FileDiff`:
relative path, create/edit/delete kind, complete unified patch, additions, and
deletions. `src/tools/file-diff.ts` builds it with `diffLines` and `createPatch`.
Counts describe changed source lines, including a final-newline change, rather
than counting the patch's headers. Missing and empty files remain distinct.

The registry constructs the proposed diff before approval and returns it only
after a successful write. These tools write the supplied content directly;
there is no formatter or post-processing step to change the applied diff.
Existing read-before-write, unique-match, path/ignore checks, approvals, and
undo records remain in place. Identical-content updates do not write or add an
undo entry. Literal replacement text such as `$&` is no longer interpreted as
a JavaScript replacement pattern.

## UI pipeline

`ApprovalRequest.fileDiff` and `ToolExecutionResult.fileDiff` carry the same
structured representation. `TuiTranscriptLine.fileDiff` is a dedicated UI field,
not an ANSI string or serialized JSON to parse later. The entry's short text
remains useful for search and existing transcript utilities.

`src/ui/file-diff.tsx` uses the installed diff library's `parsePatch` to build a
bounded render model with independent old/new line numbers. `FileDiffView` is
shared by approval and transcript rendering. Added/removed rows use the theme's
green/red colors plus `+`/`-`; `NO_COLOR` retains all structural information.
Narrow terminals use compact `+N -M` statistics. File content is displayed as
text, with terminal control sequences removed from the display only.

Approvals have a scroll viewport with pinned decision controls. Arrows, mouse
wheel, Page Up/Down, and Home/End navigate it. The live activity row is temporary
and becomes one result entry after execution, including in classic terminal
mode. Errors still produce error entries.

## Persistence

`Session.fileDiffs` is an optional map keyed by tool-use id. The agent loop saves
only applied results here. Existing JSON session storage preserves the complete
patch. `replaySessionIntoTranscript` restores the result at its original tool
result position and suppresses the redundant tool-start entry. This metadata is
outside `ChatMessage`, so Anthropic/OpenAI-compatible payloads are unchanged.
Sessions written before this feature continue to replay their ordinary text.

## Deliberate limits

- Unified/stacked layout only; side-by-side layout and a style selector are not
  implemented. Parsing and rendering are separated for a future layout.
- Each view renders at most 200 diff rows, including hunk headers and newline
  notes. The footer reports the exact number of omitted rows. Complete patches
  remain in metadata and saved sessions.
- Source rows are clipped to terminal width with an ellipsis; each row is also
  bounded to 1,000 characters before rendering. A footer reports rows shortened
  by the character limit. Horizontal scrolling and an expanded full-patch viewer
  are not included.
- Old sessions cannot recover diffs that were never stored. Replay retains its
  existing last-30-messages limit.

## Validation

Tests cover line counts, newline handling, multiple hunks, old/new numbering,
large and long diffs, literal replacements, empty files, write/overwrite/edit,
proposed approvals, denied writes, undo preservation, live transcript results,
approval scrolling, narrow rendering, `NO_COLOR`, session storage/replay, and
absence of UI metadata in provider requests. Run `bun run typecheck`, `bun test`,
and `bun run lint`.
