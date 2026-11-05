# Zotero Copilot

Zotero Copilot is a Zotero 8 plugin that adds a chat sidebar to Zotero for asking questions about your library items, PDF attachments, and extracted Markdown context.

## Features

- Standalone Copilot sidebar inside the Zotero main window
- Persistent multi-session chat history stored in Zotero
- Context ingestion from dragged Zotero items, active PDF attachments, and MinerU Markdown results
- Configurable model providers, models, system prompts, and auto-title model
- Markdown and formula rendering in the sidebar
- GitHub Actions release workflow that builds and publishes tagged releases

## MinerU result selection

MinerU results are matched to their source PDF through Related Items, including standalone PDFs and attachments moved to another parent. When adding a whole library item, Copilot uses the first PDF with a linked result, or the first PDF if none has one. Multiple results linked to the same PDF use the highest attachment ID.

Older unlinked results are reused only when there is one PDF and one parse attachment with no link to another PDF. Items without PDFs can use a unique unlinked parse attachment. Ambiguous results are not guessed. HTML results still read companion Markdown or embedded Markdown source.

## Chat context and recovery

Outbound message context has a shared limit of 120,000 serialized JSON characters across the system prompt, retained conversation, and source excerpts. This is a character limit rather than a model-specific token count. The newest question stays intact; oversized history is removed by complete turns. Source excerpts use the remaining space, newest first, and identical snapshots of the same source are included once. The sidebar reports when history or excerpts are trimmed. Request budgeting does not modify saved conversations or source snapshots.

An oversized current question or tool result produces an explicit error before an oversized request is sent. Tool-call turns remain intact. Failed saves and stopped requests restore the composer; partial answers stay available when a connection fails. Automatic titles run in the background and update only the title, preserving later messages and manual renames.

## Requirements

- Zotero `8.0` to `9.*`

## Installation

1. Download the latest `.xpi` from the GitHub Releases page.
2. In Zotero, open `Tools -> Plugins`.
3. Use `Install Add-on From File...` and select the downloaded `.xpi`.

The plugin update metadata is published through [`updates.json`](./updates.json).

## Development

### Checks

With Node.js 20 or newer, run:

```powershell
node scripts/check.js
```

This checks JavaScript syntax and runs the MinerU reader, Markdown copy, and chat-runtime regressions. The chat checks cover save failures, cancellation, late responses, background titles, context budgets, and stream boundaries without making network requests. Branch pushes and pull requests run these checks and build the XPI; tagged releases run the checks before packaging and publishing.

### Build

Use the PowerShell build script from the repository root:

```powershell
pwsh -File .\build.ps1
```

This creates a validated XPI in `dist/`.

### Release

Tagged releases are published through GitHub Actions.

1. Ensure `manifest.json` contains the intended version.
2. Commit changes to `main`.
3. Push a matching tag such as `v0.3.31`.

The workflow in [`.github/workflows/release.yml`](./.github/workflows/release.yml) will:

- build the XPI
- publish a GitHub Release asset
- update `updates.json`

## Repository

- Homepage: <https://github.com/lisontowind/zotero-copilot>
- Add-on ID: `zotero-copilot@example.com`

## License

MIT. See [LICENSE](./LICENSE).
