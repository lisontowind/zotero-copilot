# Zotero Copilot

## Overview

This repository contains a Zotero 8 plugin that adds a standalone Copilot sidebar to the main Zotero window.

Current plugin identity:

- Add-on ID: `zotero-copilot@example.com`
- Current version: `0.2.79`
- Author: `Lisontowind`
- GitHub repo: `https://github.com/lisontowind/zotero-copilot`
- Entry files:
  - `manifest.json`
  - `bootstrap.js`
  - `copilot.js`
  - `preferences.xhtml`
  - `preferences.js`
  - `preferences.css`
  - `prefs.js`

The plugin is implemented in classic Zotero bootstrap style, not as a modern web app.


## High-Level Architecture

### 1. Bootstrap Layer

File: `bootstrap.js`

Responsibilities:

- Wait for `Zotero.initializationPromise`
- Load vendored runtimes:
  - `vendor/katex/katex.min.js`
  - `vendor/marked/marked.umd.js`
- Register the preferences pane with `Zotero.PreferencePanes.register(...)`
- Load `copilot.js`
- Initialize `ZoteroCopilot`
- Attach UI to all open main windows

Important lifecycle hooks:

- `startup({ id, version, rootURI })`
- `onMainWindowLoad({ window })`
- `onMainWindowUnload({ window })`
- `shutdown()`


### 2. Main Plugin Runtime

File: `copilot.js`

Top-level singleton:

- `ZoteroCopilot = { ... }`

The plugin keeps per-window UI state in:

- `windows: new WeakMap()`

Each window state currently contains:

- window/document references
- toolbar button
- sidebar panel and splitter
- current session
- session list
- pending context chips
- edit target message id
- send/streaming state
- request abort controller / stream reader / active request id


### 3. Preferences Layer

Files:

- `preferences.xhtml`
- `preferences.js`
- `preferences.css`
- `prefs.js`

Responsibilities:

- Manage named AI profiles
- Persist API base URL / API key / model / extra request JSON
- Select active profile
- Test API connectivity

Preference keys:

- `extensions.zotero-copilot.llmApiBaseURL`
- `extensions.zotero-copilot.llmApiKey`
- `extensions.zotero-copilot.llmModel`
- `extensions.zotero-copilot.llmRequestJSON`
- `extensions.zotero-copilot.chatCollectionKey`
- `extensions.zotero-copilot.chatStoreItemKey`
- `extensions.zotero-copilot.llmProfilesJSON`
- `extensions.zotero-copilot.activeLLMProfileID`

Profile management is implemented in `preferences.js` under `ZoteroCopilotPreferences`.


## UI Model

The plugin does **not** currently use Zotero’s official item-pane section API for the main chat UI.

Instead it injects:

- a toolbar button into the center toolbar
- a standalone right-side sidebar panel
- a splitter between Zotero’s content area and the Copilot panel

Main UI entry points:

- `addToWindow(window)`
- `buildStandaloneSidebarUI(doc)`
- `buildViewUI(doc)`
- `attachViewListeners(state)`

Core UI elements:

- top header with session button, title button, `New Chat`
- session popup menu
- status line
- message list
- composer resize bar
- context chip list
- input textarea
- profile selector popup
- `Cancel`, `Stop`, `Send` buttons


## Session / Conversation Model

### Storage Strategy

Sessions are stored under **one Zotero parent item** with **multiple JSON attachments**.

Current concepts:

- chat collection name: `Zotero Copilot Chats`
- store item title: `Zotero Copilot Sessions`
- tag: `#Zotero-Copilot-Chat`

Main storage functions:

- `ensureConversationStore()`
- `findConversationStoreItem(collection)`
- `getAllSessions()`
- `loadSessionAttachment(storeItem, attachment)`
- `saveSession(session)`
- `createConversationAttachment(parentItem, data, fileName)`

Session file naming:

- New format: `xxxxxxxx-YYYYMMDD.json`
- Old formats are still read for compatibility

Session title behavior:

- Default title: `新会话`
- Can be manually renamed
- First completed user turn may auto-title the session


### Message Model

A session typically contains:

- `sessionID`
- `title`
- `createdAt`
- `updatedAt`
- `messages`

Messages can include:

- `messageID`
- `role`
- `content`
- `reasoning`
- `reasoningCollapsed`
- `sourceRefs`
- `createdAt`
- `editedAt`
- `error`
- `stopped`
- `stoppedAt`


## Context Ingestion

Supported drag/drop source types:

- note items
- Markdown attachments
- PDF attachments
- regular Zotero items

Regular item behavior:

- Prefer parsed Markdown from `zotero-mineru` if available
- Otherwise fall back to first PDF attachment
- If no usable PDF context exists, reject

Key functions:

- `extractDroppedItems(...)`
- `handleDrop(...)`
- `addPendingItemsToComposer(...)`
- `resolveContextSource(...)`
- `resolveNoteSource(...)`
- `resolveMarkdownSource(...)`
- `resolvePDFAttachmentSource(...)`
- `resolveRegularItemSource(...)`
- `extractPDFTextWithFallback(...)`

The UI model is:

- drag items into the input area
- sources appear as chips above the input
- after `Send`, those source refs are attached to that user message


## Chat Request Flow

Primary chat path:

- `handleSend(state)`
- `runUserTurn(state, { ... })`
- `requestChatCompletion({ ... })`

Transport details:

- OpenAI-compatible `/chat/completions`
- stream first, non-stream fallback
- extra request JSON allowed but reserved keys are protected

Relevant functions:

- `getLLMProfiles()`
- `getActiveLLMProfile()`
- `getLLMSettings()`
- `parseOptionalJSONObject(...)`
- `mergeRequestPayload(...)`
- `buildChatMessages(session)`
- `buildSourceContextBlock(sourceRefs)`
- `requestChatCompletionStream(...)`
- `requestChatCompletionNonStream(...)`
- `extractStreamDelta(parsed)`


## Editing / Regeneration Model

Current intended behavior:

- User message has an edit action
- Clicking edit loads message text + source refs back into composer
- Send button changes from `Send` to `Regenerate`
- `Cancel` exits edit mode

Relevant functions:

- `handleMessageAction(state, action, messageID)`
- `cancelEdit(state)`
- `updateSendButton(state)`

The plugin tries to preserve edit state across normal rerenders, but this area has changed repeatedly and should be treated as fragile.


## Streaming / Stop Model

Current generation control fields in window state:

- `isSending`
- `requestAbortController`
- `stopRequested`
- `currentStreamReader`
- `activeRequestID`
- `currentStreaming`

Relevant functions:

- `appendStreamingAssistantMessage(state)`
- `handleStopGeneration(state)`
- `finalizeStoppedRequest(state)`
- `runUserTurn(...)`

Important note:

- `Stop` has been reworked multiple times.
- The current design tries to stop both transport and UI:
  - `AbortController.abort()`
  - `reader.cancel()`
  - local UI finalization


## Markdown / Formula Rendering

### Current Rendering Strategy

`setMarkdownContent(el, markdownText)` is the main entry point for message rendering.

The current code does **not** rely purely on `marked` anymore for the visible message DOM.

Instead it uses:

- `buildMarkdownNodes(doc, markdownText)`
- manual block parsing
- manual inline token parsing
- formula post-processing pass

Relevant functions:

- `setMarkdownContent(...)`
- `buildMarkdownNodes(...)`
- `appendInlineMarkdownNodes(...)`
- `buildInlineMarkdownNodes(...)`
- `tokenizeFormulaPlaceholders(...)`
- `postProcessFormulaNodes(...)`
- `buildFormulaNode(...)`

### Formula Rendering

KaTeX support is vendored under:

- `vendor/katex/...`

Runtime helpers:

- `ensureKatexRuntime()`
- `getKatexRenderer()`
- `buildFormulaNode(...)`
- `renderFormulaHTML(...)`

Supported target syntaxes in code:

- `$...$`
- `$$...$$`
- `\(...\)`
- `\[...\]`

### Important Current Reality

Formula rendering is still unstable.

Recent work attempted:

- direct KaTeX DOM render
- HTML document render then import back
- namespace-aware cloning for MathML/SVG
- UMD/CommonJS KaTeX loading
- placeholder-based formula tokenization
- post-process replacement of residual formula source

The user’s latest report is:

- formulas still show as raw source
- session switching also regressed

Treat the formula path as **currently unresolved**.


## Copy / Markdown Serialization

Rendered messages are selectable and copyable.

Copy logic:

- `handleMessagesCopy(state, event)`
- `serializeFragmentToMarkdown(fragment)`
- `serializeMarkdownNode(node, context)`
- `normalizeCopiedMarkdown(text)`

The intention is:

- copy rendered content
- write markdown-like plain text back to clipboard
- preserve formulas using `data-md-formula`


## Known Fragile Areas

These areas have changed repeatedly and should be handled carefully:

### 1. Session menu interaction

The user’s latest report says:

- session popup opens
- clicking session items does not switch conversations

Recent attempts:

- event delegation on menu container
- direct per-option click handlers
- generation-state gating changes

This area needs real runtime validation in Zotero.

### 2. Formula rendering

Still not working according to latest user feedback.

Current likely problem buckets:

- parser path not actually reaching formula branch
- formula branch reached but rerender path replaced output later
- message DOM may still fall back to plain text somewhere unexpected

### 3. Stop behavior

Stop has been partially hardened, but transport semantics in Zotero may still differ from browser expectations.

### 4. Sidebar injection

The plugin uses manual DOM injection into Zotero’s main window.

Key assumptions:

- toolbar anchor exists
- sidebar mount node exists
- inserted splitter/panel structure remains compatible with Zotero 8.x


## File Guide

### `manifest.json`

Add-on metadata and compatibility range.

### `bootstrap.js`

Plugin startup / shutdown / runtime loading / preference registration.

### `copilot.js`

Main runtime. This is the core file and currently contains:

- UI creation
- event wiring
- markdown rendering
- formula handling
- drag/drop context resolution
- session persistence
- LLM request logic

This file is large and mixes concerns.

### `preferences.xhtml`

Preference pane layout.

### `preferences.js`

Preference pane controller for named AI profiles and connection test.

### `preferences.css`

Preference pane styling with dark-mode-aware adjustments.

### `prefs.js`

Default pref declarations.

### `vendor/katex`

Vendored KaTeX runtime and CSS.

### `vendor/marked`

Vendored Marked runtime.

### `locale/...`

Localization resources.


## Suggested Refactor Directions

If continuing work on this repository, the highest-value cleanup would be:

1. Split `copilot.js` into modules by concern:
   - UI / DOM
   - storage
   - markdown rendering
   - context extraction
   - transport

2. Add explicit debug flags or status overlays for:
   - markdown render path
   - formula detection path
   - KaTeX runtime availability
   - session switch click handling

3. Stabilize session menu interaction with the simplest possible event model.

4. Decide on one markdown strategy:
   - fully manual parser
   - or trusted HTML parser + conversion
   - but not both mixed together

5. Add a very small local test harness for markdown/formula rendering outside Zotero.


## Practical Notes For Future Editing

- Use `apply_patch` for manual file edits.
- Do not assume the latest `.xpi` reflects stable behavior; many versions were built during iterative debugging.
- `zotero-copilot-0.2.46.xpi` and `zotero-copilot-0.2.47.xpi` are malformed archives, not valid ZIP/XPI packages. They appear to have been produced with the wrong archive format and Zotero reports them as incompatible.
- Do not build `.xpi` files with `tar` or ad hoc archive commands. XPI must be a ZIP archive.
- Use `pwsh -File .\\build.ps1` from the repo root for packaging. The script stages only runtime files and writes a validated build to `dist\\zotero-copilot-<version>.xpi`.
- GitHub release automation lives in `.github/workflows/release.yml`. Publish by pushing a tag like `v0.2.79`; the workflow builds the XPI, updates `updates.json`, pushes metadata back to `main`, and creates a GitHub Release asset named `zotero-copilot.xpi`.
- Keep `dist/`, local `.xpi` outputs, and vendor `.tgz` tarballs out of git. `.gitignore` now treats those as local build artifacts.
- Preserve existing user data migration behavior when touching session storage.
- Avoid changing storage shape casually; multiple migration paths already exist.
- The sidebar `Duplicate` button clones the current session and opens the clone. It does not copy text to the clipboard.
- Session auto-titling now runs when the first user message is sent, using that message plus any first-turn context source labels. It sets `autoTitleLocked` on the session so the same conversation is not auto-renamed again. The model used for auto-titling is configurable via the `titleLLMProfileID` preference; an empty value means "follow the current chat model".
- During generation, keep the session switcher disabled and avoid any refresh path that re-renders the active session, or the in-flight streaming node will disappear from the UI.
- Stop generation must work even if the host environment does not expose a usable global `AbortController`; keep the reader-cancel fallback path intact.
- Be careful when touching `renderCurrentSession(...)`, `switchToSession(...)`, and `runUserTurn(...)` together. Those three functions are tightly coupled.
- Be careful when touching `setMarkdownContent(...)`, `buildMarkdownNodes(...)`, and `buildFormulaNode(...)`. Rendering regressions have repeatedly originated there.
- Formula copy behavior depends on `data-md-formula` and `data-md-formula-display` surviving on rendered formula DOM. If formula copy regresses, inspect `annotateFormulaTree(...)`, `getSerializedFormulaSource(...)`, and the copy handler before changing KaTeX rendering again.
- The sidebar toggle should now be anchored in the main Zotero toolbar immediately to the right of the sync button when `#zotero-tb-sync` is present, with a visual separator between sync and Copilot.
- PDF context entry is no longer attached to the input-box right-click menu. The current interaction is a bottom-left `+` button in the composer footer that opens a popup menu and stays hidden outside active PDF reader tabs.
- The `+` popup actions should reuse the same `addPendingItemsToComposer(...)` path as drag and drop. If the popup can be clicked but no pending source chip appears, debug that shared ingestion path first rather than adding another parallel context-add implementation.
- The `+` control now uses an inline SVG icon rather than text glyph metrics. If centering regresses again, inspect `createPlusIcon(...)` and `.zc-context-button-glyph` before tweaking button padding.
- For the toolbar separator, prefer cloning an existing Zotero separator from the same toolbar before falling back to a custom node. This is the current best attempt to match the native sync/tab separator appearance.
- In the current host UI, popup menu item activation is more reliable on `pointerdown` than on `click`. If the `+` popup appears but selecting an item does nothing, inspect `onContextMenuPointerDown` first.
- The `MinerU` popup action must add the Markdown attachment itself, not the parent bibliographic item. If it starts adding the parent item again, inspect `getContextMenuActions(...)`.
- Sidebar button feedback is intentionally stronger than earlier builds. When tweaking visuals, preserve the more visible hover/pressed states on `.zc-btn`, `.zc-message-action`, `.zc-chip-remove`, and `.zc-context-menu-item` unless the whole interaction language is being redesigned.


## Current Status Summary

As of version `0.2.79`:

- Plugin installs from `dist\\zotero-copilot-0.2.79.xpi` and packaging is done through `build.ps1`
- Preferences pane exists and uses native `select` controls for provider/model configuration
- Session persistence under one Zotero store item exists
- Sidebar session actions currently include rename, duplicate, delete, and new chat
- `Duplicate` creates a new session attachment with copied messages and switches the UI to that clone
- Session titles can be generated automatically on the first user message, using a configurable naming model from settings and first-turn context labels
- The "Add models" dialog supports local search/filtering over the fetched model list
- Named system prompt profiles can be saved in settings and selected from the sidebar independently of the model choice
- While generating, the session switcher is disabled and selecting the already-active session no longer re-renders the message list
- Stop generation now also falls back to reader cancellation when a standard `AbortController` is unavailable in the host environment
- The sidebar toggle button should sit in the main Zotero toolbar next to the sync button, rather than being duplicated across reader/PDF toolbars
- A separator should appear between the sync button and the Copilot toolbar toggle
- The composer footer should expose a left-aligned square `+` button that opens a popup menu of PDF-context actions for the active PDF reader tab, including MinerU markdown when available, and the button should be hidden outside PDF reader tabs
- The `+` glyph should be centered explicitly with its own inner span rather than relying on button text metrics
- If the popup action resolves but adds no chip, the UI should now surface an explicit extraction failure status rather than silently doing nothing
- The `+` popup action is triggered on `pointerdown` to avoid losing the event in Zotero's popup/button host environment
- The `MinerU` popup entry should now add the MinerU Markdown attachment as context, rather than routing through the parent item
- Sidebar buttons and icon controls should now have stronger hover rings, shadows, and pressed states for clearer interaction feedback
- Drag/drop context ingestion exists
- Streaming chat exists
- Edit / regenerate / stop flows exist
- Formula rendering now prefers a shared global KaTeX runtime and always imports rendered KaTeX HTML through the namespace-safe DOMParser clone path, with fallback handling retained
- If formulas regress to raw source again, inspect `parseHTMLToNodes(...)`, `cloneHTMLNodeIntoDocument(...)`, `resolveKatexRuntime(...)`, and fallback logs before changing delimiter parsing rules
- Copying selected markdown should preserve formula delimiters; inline math should copy as `$...$` and block math should copy as `$$...$$` with blank-line separation
- Sidebar layout currently expects the model selector above the input, left-aligned, with tighter vertical spacing than earlier builds
