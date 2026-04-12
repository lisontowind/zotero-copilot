# Zotero Copilot

## Overview

This repository contains a Zotero 8 plugin that adds a standalone Copilot sidebar to the main Zotero window.

Current plugin identity:

- Add-on ID: `zotero-copilot@example.com`
- Current version: `0.3.20`
- Author: `Lisontowind`
- GitHub repo: `https://github.com/lisontowind/zotero-copilot`

Main runtime files:

- `manifest.json`
- `bootstrap.js`
- `copilot.js`
- `markdown/core.js`
- `markdown/render.js`
- `markdown/copy.js`
- `preferences.xhtml`
- `preferences.js`
- `preferences.css`
- `prefs.js`

The plugin is implemented in classic Zotero bootstrap style, not as a modern web app.


## High-Level Architecture

### Bootstrap Layer

File: `bootstrap.js`

Responsibilities:

- Wait for `Zotero.initializationPromise`
- Load vendored runtimes:
  - `vendor/katex/katex.min.js`
  - `vendor/marked/marked.umd.js`
- Register the preferences pane with `Zotero.PreferencePanes.register(...)`
- Load markdown helper modules in order:
  - `markdown/core.js`
  - `markdown/render.js`
  - `markdown/copy.js`
- Load `copilot.js`
- Initialize `ZoteroCopilot`
- Attach UI to all open main windows

Important lifecycle hooks:

- `startup({ id, version, rootURI })`
- `onMainWindowLoad({ window })`
- `onMainWindowUnload({ window })`
- `shutdown()`


### Main Plugin Runtime

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
- edit target message id / role
- raw-markdown toggled message ids
- config popup open state
- send/streaming state
- request abort controller / stream reader / active request id


### Markdown Subsystem

Files:

- `markdown/core.js`
- `markdown/render.js`
- `markdown/copy.js`

Responsibilities:

- shared markdown helpers
- formula placeholder tokenization
- markdown token-to-DOM rendering
- formula DOM annotation
- selection normalization and markdown-aware copy helpers

These modules are mixed back into `ZoteroCopilot` at runtime via `Object.assign(...)`.


### Preferences Layer

Files:

- `preferences.xhtml`
- `preferences.js`
- `preferences.css`
- `prefs.js`

Responsibilities:

- Manage named AI providers and models
- Manage named system prompts
- Persist API base URL / API key / model / extra request JSON
- Persist chat history message count and default temperature
- Select active chat model and title model
- Test API connectivity

Important pref keys:

- `extensions.zotero-copilot.llmProvidersJSON`
- `extensions.zotero-copilot.llmProfilesJSON`
- `extensions.zotero-copilot.activeLLMProfileID`
- `extensions.zotero-copilot.titleLLMProfileID`
- `extensions.zotero-copilot.systemPromptsJSON`
- `extensions.zotero-copilot.activeSystemPromptID`
- `extensions.zotero-copilot.chatHistoryMessageCount`
- `extensions.zotero-copilot.llmTemperature`
- `extensions.zotero-copilot.chatCollectionKey`
- `extensions.zotero-copilot.chatStoreItemKey`


## UI Model

The plugin does not use Zotero’s official item-pane section API for the main chat UI.

Instead it injects:

- a toolbar button into the main Zotero toolbar
- a standalone right-side sidebar panel
- a splitter between Zotero’s content area and the Copilot panel

Main UI entry points:

- `addToWindow(window)`
- `buildStandaloneSidebarUI(doc)`
- `buildViewUI(doc)`
- `attachViewListeners(state)`

Core sidebar elements:

- top header with session controls
- session selector
- status line
- message list
- composer resize bar
- context chip list
- model selector
- system prompt selector
- input textarea
- bottom-left `+` context popup
- bottom-left chat-parameter popup
- `Cancel`, `Regenerate`, `Stop`, `Send` buttons


## Session / Conversation Model

### Storage Strategy

Sessions are stored under one Zotero parent item with multiple JSON attachments.

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

- current format: `xxxxxxxx-YYYYMMDD.json`
- older formats are still read for compatibility


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

Current UI model:

- drag items into the input area
- or use the bottom-left `+` popup in active PDF reader tabs
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
- temperature is now a dedicated pref-backed field

Relevant functions:

- `getLLMProfiles()`
- `getActiveLLMProfile()`
- `getLLMSettings()`
- `getChatHistoryMessageCount()`
- `getLLMTemperature()`
- `parseOptionalJSONObject(...)`
- `mergeRequestPayload(...)`
- `buildChatMessages(session)`
- `buildSourceContextBlock(sourceRefs)`
- `requestChatCompletionStream(...)`
- `requestChatCompletionNonStream(...)`
- `extractStreamDelta(parsed)`


## Editing / Raw Markdown / Deletion

Current message bubble actions:

- copy original markdown/text
- toggle raw markdown view
- edit user or assistant message
- delete the last message only

Important behavior:

- Raw markdown is the supported manual selection/copy path
- Reasoning / thought content should follow the same raw-markdown toggle behavior
- The delete button appears only on the last bubble
- Last-message deletion requires confirmation

Relevant functions:

- `handleMessageAction(state, action, messageID)`
- `toggleMessageRawMarkdown(state, messageID)`
- `deleteLastMessage(state, messageID)`
- `cancelEdit(state)`
- `updateSendButton(state)`


## Markdown / Formula Rendering

### Current Rendering Strategy

`setMarkdownContent(el, markdownText)` is the main entry point for message rendering.

The visible markdown DOM now goes through a single modularized path:

- tokenize formulas
- lex/tokenize markdown
- repair tokens where needed
- render DOM nodes
- annotate nodes with markdown source metadata

Relevant functions:

- `setMarkdownContent(...)`
- `tokenizeFormulaPlaceholders(...)`
- `renderMarkdownTokens(...)`
- `renderInlineMarkdownToken(...)`
- `buildFormulaNode(...)`
- `setMarkdownSourceAttribute(...)`

### Formula Rendering

KaTeX support is vendored under:

- `vendor/katex/...`

Runtime helpers:

- `ensureKatexRuntime()`
- `getKatexRenderer()`
- `buildFormulaNode(...)`
- `annotateFormulaTree(...)`

Supported target syntaxes in code:

- `$...$`
- `$$...$$`
- `\(...\)`
- `\[...\]`

Important current reality:

- Formula rendering is usable, but still fragile
- Formula block sizing and overflow have been tuned repeatedly
- If formulas regress, inspect both the renderer and the CSS for:
  - `.zc-formula-inline`
  - `.zc-formula-block`


## Copy / Markdown Serialization

Current user-facing copy behavior:

- Default rendered markdown is selectable and uses markdown-aware copy handling
- Each bubble has a copy-original action
- Each bubble can be toggled into raw markdown for manual selection/copy

Underlying copy helpers still exist and are tested:

- `handleMessagesCopy(state, event)`
- `serializeFragmentToMarkdown(fragment)`
- `serializeMarkdownNode(node, context)`
- `normalizeCopiedMarkdown(text)`
- `normalizeRangeForCopy(...)`

The intention is:

- preserve original markdown where annotated source exists
- preserve formulas using `data-md-formula`
- preserve hard line breaks and raw markdown content


## Known Fragile Areas

These areas have changed repeatedly and should be handled carefully:

### 1. Formula rendering / sizing

This can regress when changing:

- KaTeX import path
- formula node annotation
- last-child block spacing
- inline/block formula font sizing
- formula overflow styling

### 2. Stop / streaming behavior

Stop is better than earlier versions, but host transport semantics in Zotero still differ from normal browser expectations.

### 3. Sidebar injection

The plugin uses manual DOM injection into Zotero’s main window.

Key assumptions:

- toolbar anchor exists
- sidebar mount node exists
- inserted splitter/panel structure remains compatible with Zotero 8.x

### 4. Rendered markdown / copy UX

Rendered-text selection/copy is enabled and should preserve markdown-aware clipboard output. Treat further copy UX changes as high risk and validate with the local harness before changing behavior.


## File Guide

### `manifest.json`

Add-on metadata and compatibility range.

### `bootstrap.js`

Plugin startup / shutdown / runtime loading / preference registration.

### `copilot.js`

Main runtime. This file currently contains:

- UI creation
- event wiring
- session persistence
- drag/drop context resolution
- LLM request logic
- raw-markdown toggle behavior
- last-message deletion
- sidebar config popup

### `markdown/core.js`

Shared markdown helpers, formula helpers, DOM annotation helpers, range normalization helpers.

### `markdown/render.js`

Primary markdown rendering path from tokens to DOM.

### `markdown/copy.js`

Markdown-aware copy and selection serialization helpers.

### `preferences.xhtml`

Preference pane layout.

### `preferences.js`

Preference pane controller for provider/model/prompt management and chat parameter settings.

### `preferences.css`

Preference pane styling.

### `prefs.js`

Default pref declarations.


## Practical Notes For Future Editing

- Use `apply_patch` for manual file edits.
- Use `pwsh -File .\\build.ps1` from the repo root for packaging. The script stages only runtime files and writes a validated build to `dist\\zotero-copilot-<version>.xpi`.
- GitHub release automation lives in `.github/workflows/release.yml`. Publish by pushing a tag like `v0.3.20`; the workflow builds the XPI, updates `updates.json`, pushes metadata back to `main`, and creates a GitHub Release asset named `zotero-copilot.xpi`.
- Do not build `.xpi` files with `tar` or ad hoc archive commands. XPI must be a ZIP archive.
- Keep `dist/`, local `.xpi` outputs, and vendor `.tgz` tarballs out of git.
- Preserve existing user data migration behavior when touching session storage.
- Avoid changing storage shape casually; multiple migration paths already exist.
- The sidebar `Duplicate` button clones the current session and opens the clone. It does not copy text to the clipboard.
- Session auto-titling runs when the first user message is sent and can use a dedicated title model.
- During generation, keep the session switcher stable and avoid refresh paths that destroy the in-flight streaming node.
- Stop generation must keep the reader-cancel fallback path intact when a usable global `AbortController` is unavailable.
- Be careful when touching `renderMessages(...)`, `refreshSessions(...)`, `switchToSession(...)`, and `runUserTurn(...)` together.
- The `+` popup actions should reuse the same `addPendingItemsToComposer(...)` path as drag and drop.
- The chat-parameter control should behave like the `+` control: a footer button that opens a floating popup, not a permanently visible inline settings block.
- The chat-parameter popup should only close when clicking outside it or pressing `Cancel`. Clicking inputs should not dismiss it.
- The default temperature is `0.7` unless the user has already saved another value.
- The delete action should stay limited to the last bubble and should keep a confirmation step.


## Current Status Summary

As of version `0.3.20`:

- Plugin installs from `dist\\zotero-copilot-0.3.20.xpi` and packaging is done through `build.ps1`
- Preferences pane supports provider/model/system-prompt management plus chat history count and temperature
- Session persistence under one Zotero store item exists
- Sidebar session actions include rename, duplicate, delete, and new chat
- The composer footer has a left-aligned `+` context popup and a floating settings popup
- Drag/drop context ingestion exists
- Streaming chat exists
- Edit / regenerate / stop flows exist
- Markdown rendering is modularized through `markdown/core.js`, `markdown/render.js`, and `markdown/copy.js`
- The current copy UX is raw-markdown-first rather than rendered-selection-first
- Thought/reasoning content follows the same raw-markdown toggle behavior as the main response body
- The last message bubble exposes a delete button to the left of the copy button, and deletion requires confirmation
- Formula rendering is usable, but still an area that needs careful regression checking
