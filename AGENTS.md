# Maintainer-directed work

- Work directly in `main`. Do not create development branches, worktrees or pull requests unless the maintainer explicitly changes this instruction.
- Preserve unrelated working changes. Do not reset, force push or rewrite history.
- Read the current source and tests before applying historical specifications. Complete the requested runtime and UI integration, not only contracts or mocks.
- Keep `/help` removed and preserve the welcome screen hotkeys.
- UI changes need a preview from the actual OpenTUI renderer, with terminal captures rather than generated mockups.
- Run the repository quality checks and relevant packaging/compiled smoke. Report actual results and any unverified platform checks honestly.
