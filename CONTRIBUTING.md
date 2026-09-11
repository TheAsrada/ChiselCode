# Contributing to ChiselCode

Thanks for improving ChiselCode.

## Development setup

1. Install Bun 1.2 or newer and ripgrep.
2. Fork the repository and create a branch from `main`.
3. Install exact dependency versions with `bun install --frozen-lockfile`.
4. Run `bun run typecheck`, `bun test`, and `bun run lint` before opening a pull request.

## Pull requests

- Keep each pull request focused and describe its user-visible impact.
- Include tests for behavior changes and update `README.md` or `CHANGELOG.md` when appropriate.
- Do not commit API keys, generated binaries, `node_modules`, session data, or `.env` files.
- Preserve the deny-by-default approval model and project-root path restrictions.

## Reporting issues

Use GitHub Issues for bugs and feature requests. Security-sensitive reports must follow [SECURITY.md](SECURITY.md), not a public issue.
