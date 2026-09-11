# Changelog

All notable changes to ChiselCode are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2] - 2026-09-11

### Fixed

- Run the repository-pinned Biome binary in package scripts instead of fetching a formatter dynamically.

## [0.1.1] - 2026-09-11

### Fixed

- Normalize asynchronous tool failures into structured tool results so policy violations do not terminate the agent loop.

## [0.1.0] - 2026-09-11

### Added

- Bun/TypeScript coding-agent CLI with an Ink TUI and one-shot mode.
- Anthropic, OpenAI, and OpenAI-compatible provider adapters.
- Secure project-scoped file, search, shell, and Git tools with approval previews.
- Persistent sessions, context composition, credential fallback storage, and JSON output.
- Unit and integration test coverage, formatting/lint checks, and release automation.
