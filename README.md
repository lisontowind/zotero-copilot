# Zotero Copilot

Zotero Copilot is a Zotero 8 plugin that adds a chat sidebar to Zotero for asking questions about your library items, PDF attachments, and extracted Markdown context.

## Features

- Standalone Copilot sidebar inside the Zotero main window
- Persistent multi-session chat history stored in Zotero
- Context ingestion from dragged Zotero items, active PDF attachments, and MinerU Markdown results
- Configurable model providers, models, system prompts, and auto-title model
- Markdown and formula rendering in the sidebar
- GitHub Actions release workflow that builds and publishes tagged releases

## Requirements

- Zotero `8.0` to `9.*`

## Installation

1. Download the latest `.xpi` from the GitHub Releases page.
2. In Zotero, open `Tools -> Plugins`.
3. Use `Install Add-on From File...` and select the downloaded `.xpi`.

The plugin update metadata is published through [`updates.json`](./updates.json).

## Development

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
3. Push a matching tag such as `v0.2.75`.

The workflow in [`.github/workflows/release.yml`](./.github/workflows/release.yml) will:

- build the XPI
- publish a GitHub Release asset
- update `updates.json`

## Repository

- Homepage: <https://github.com/lisontowind/zotero-copilot>
- Add-on ID: `zotero-copilot@example.com`

## License

MIT. See [LICENSE](./LICENSE).
