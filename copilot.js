ZoteroCopilot = {
	id: null,
	version: null,
	rootURI: null,
	initialized: false,
	windows: new WeakMap(),

	PREF_BRANCH: "extensions.zotero-copilot.",
	COLLECTION_NAME: "Zotero Copilot Chats",
	STORE_ITEM_TITLE: "Zotero Copilot Sessions",
	CHAT_TAG: "#Zotero-Copilot-Chat",
	CONVERSATION_FILE_NAME: "conversation.json",
	SESSION_FILE_PREFIX: "session-",
	DEFAULT_SESSION_TITLE: "新会话",
	DEFAULT_SYSTEM_PROMPT_NAME: "默认学术助手",
	DEFAULT_SYSTEM_PROMPT_CONTENT: "You are Zotero Copilot, an academic research assistant embedded in Zotero. Use the provided source context snapshots when relevant. If context is insufficient, say so explicitly. Respond in the user's language unless asked otherwise.",
	PREF_PANE_ID: "zotero-copilot-prefpane",
	SOURCE_LIMIT_CHARS: 40000,
	CONTEXT_LIMIT_CHARS: 120000,
	MAX_HISTORY_MESSAGES: 20,
	STREAM_RENDER_INTERVAL_MS: 80,
	STREAM_RENDER_DEGRADE_THRESHOLD: 16000,
	STREAM_AUTO_SCROLL_THRESHOLD_PX: 48,
	HTML_NS: "http://www.w3.org/1999/xhtml",
	MATHML_NS: "http://www.w3.org/1998/Math/MathML",
	SVG_NS: "http://www.w3.org/2000/svg",

	init({ id, version, rootURI }) {
		if (this.initialized) return;
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
		this.initialized = true;
	},

	log(msg) {
		Zotero.debug("Zotero Copilot: " + msg);
	},

	async main() {
		this.log(`Loaded v${this.version}`);
	},

	addToAllWindows() {
		let windows = Zotero.getMainWindows?.() || [];
		for (let window of windows) {
			if (!window?.ZoteroPane) continue;
			this.addToWindow(window);
		}
	},

	removeFromAllWindows() {
		let windows = Zotero.getMainWindows?.() || [];
		for (let window of windows) {
			if (!window?.ZoteroPane) continue;
			this.removeFromWindow(window);
		}
	},

	addToWindow(window) {
		if (!window?.document || this.windows.has(window)) return;
		let mount = this.findSidebarMount(window);
		let toolbar = this.findToolbar(window);
		if (!mount || !toolbar) {
			this.log("Could not find sidebar mount point or toolbar");
			return;
		}
		let doc = window.document;
		this.ensureDocumentStyle(doc);
		let ui = this.buildStandaloneSidebarUI(doc);
		mount.appendChild(ui.splitter);
		mount.appendChild(ui.panel);
		let toolbarSeparator = this.buildToolbarSeparator(doc, toolbar);
		this.insertToolbarButton(toolbar, ui.toolbarButton, toolbarSeparator);

		let state = {
			window,
			doc,
			mount,
			currentItem: this.getSelectedItem(window),
			isOpen: false,
			isSessionMenuOpen: false,
			isProfileMenuOpen: false,
			pendingSourceRefs: [],
			editTargetMessageID: null,
			editTargetRole: null,
			resizePointerId: null,
			resizeStartY: 0,
			resizeStartHeight: 0,
			...ui,
			currentSession: null,
			sessions: [],
			isSending: false,
			requestAbortController: null,
			stopRequested: false,
			currentStreamReader: null,
			activeRequestID: null,
			currentStreaming: null,
			contextMenuActions: [],
			toolbarSeparator
		};
		this.windows.set(window, state);
		this.attachViewListeners(state);
		this.renderPendingSources(state);
		this.setSidebarOpen(state, this.getBoolPref("sidebarOpen", false));
		this.refreshSessions(state).catch((e) => {
			Zotero.logError(e);
			this.setStatus(state, `初始化会话失败：${e.message || e}`, true);
		});
		window.ZoteroCopilot = this;
	},

	removeFromWindow(window) {
		let state = this.windows.get(window);
		if (!state) return;
		try {
			this.detachViewListeners(state);
			state.toolbarSeparator?.remove();
			state.toolbarButton?.remove();
			state.panel?.remove();
			state.splitter?.remove();
			if (window.ZoteroCopilot === this) {
				delete window.ZoteroCopilot;
			}
		}
		catch (e) {
			Zotero.logError(e);
		}
		this.windows.delete(window);
	},

	findSidebarMount(window) {
		let doc = window.document;
		return doc.getElementById("zotero-context-pane")?.parentNode
			|| doc.getElementById("zotero-item-pane")?.parentNode
			|| doc.getElementById("zotero-item-pane-content")?.parentNode
			|| null;
	},

	findToolbar(window) {
		let doc = window.document;
		return doc.getElementById("zotero-tb-sync")?.parentNode
			|| doc.getElementById("zotero-tb-add")?.parentNode
			|| doc.getElementById("zotero-tb-lookup")?.parentNode
			|| doc.getElementById("zotero-items-toolbar")
			|| null;
	},

	ensureDocumentStyle(doc) {
		this.ensureKatexRuntime(doc);
		this.ensureKatexAssets(doc);
		if (doc.getElementById("zotero-copilot-style")) return;
		let style = doc.createElementNS(this.HTML_NS, "style");
		style.id = "zotero-copilot-style";
		style.textContent = this.getViewCSS();
		doc.documentElement.appendChild(style);
	},

	ensureKatexAssets(doc) {
		if (!doc.getElementById("zotero-copilot-katex-style")) {
			let link = doc.createElementNS(this.HTML_NS, "link");
			link.id = "zotero-copilot-katex-style";
			link.setAttribute("rel", "stylesheet");
			link.setAttribute("href", this.rootURI + "vendor/katex/katex.min.css");
			doc.documentElement.appendChild(link);
		}
	},

	buildStandaloneSidebarUI(doc) {
		let splitter = doc.createXULElement?.("splitter") || doc.createElement("splitter");
		splitter.id = "zotero-copilot-splitter";
		splitter.setAttribute("class", "zotero-copilot-splitter");
		splitter.setAttribute("collapse", "after");
		splitter.setAttribute("resizeafter", "closest");

		let panel = doc.createXULElement?.("vbox") || doc.createElement("div");
		panel.id = "zotero-copilot-panel";
		panel.setAttribute("class", "zotero-copilot-panel");

		let ui = this.buildViewUI(doc);
		panel.appendChild(ui.root);

		let toolbarButton = this.buildToolbarButton(doc);

		return {
			splitter,
			panel,
			toolbarButton,
			...ui
		};
	},

	buildToolbarButton(doc, { reader = false } = {}) {
		let toolbarButton = doc.createXULElement?.("toolbarbutton") || this.html(doc, "button", {
			type: "button"
		});
		if (reader) {
			toolbarButton.removeAttribute?.("id");
			toolbarButton.dataset.zoteroCopilotReaderButton = "true";
		}
		else {
			toolbarButton.id = "zotero-copilot-toolbar-button";
		}
		toolbarButton.setAttribute("class", `toolbarbutton-1 zotero-copilot-toolbar-button${reader ? " zotero-copilot-reader-toolbar-button" : ""}`);
		toolbarButton.setAttribute("label", "");
		toolbarButton.setAttribute("type", "button");
		toolbarButton.setAttribute("tooltiptext", "打开或关闭 Copilot 侧栏");
		toolbarButton.setAttribute("orient", "horizontal");
		toolbarButton.setAttribute("image", this.rootURI + "icon16.svg");
		toolbarButton.setAttribute("text", "");
		toolbarButton.setAttribute("title", "打开或关闭 Copilot 侧栏");
		if (!doc.createXULElement) {
			let icon = this.html(doc, "img", {
				className: "zc-toolbar-icon",
				src: this.rootURI + "icon16.svg",
				alt: "Copilot"
			});
			toolbarButton.appendChild(icon);
		}
		return toolbarButton;
	},

	buildToolbarSeparator(doc, toolbar = null) {
		let candidates = [];
		if (toolbar?.querySelectorAll) {
			candidates = Array.from(toolbar.querySelectorAll("toolbarseparator, .toolbarseparator, .toolbarbutton-separator, [class*='separator']"));
		}
		let template = candidates.find((node) => {
			let label = `${String(node.localName || "")} ${String(node.className || "")} ${String(node.id || "")}`.toLowerCase();
			return /separator/.test(label);
		}) || null;
		if (template?.cloneNode) {
			let clone = template.cloneNode(true);
			clone.removeAttribute?.("id");
			return clone;
		}
		let separator = doc.createXULElement?.("toolbarseparator") || this.html(doc, "span", {
			className: "zotero-copilot-toolbar-separator",
			"aria-hidden": "true"
		});
		separator.setAttribute?.("class", `${separator.getAttribute?.("class") || ""} zotero-copilot-toolbar-separator`.trim());
		if (!doc.createXULElement) {
			separator.textContent = "";
		}
		return separator;
	},

	insertToolbarButton(toolbar, button, separator = null) {
		if (!toolbar || !button) return;
		let syncButton = toolbar.querySelector?.("#zotero-tb-sync");
		if (syncButton?.parentNode === toolbar) {
			let insertBefore = syncButton.nextSibling;
			if (separator) {
				if (insertBefore) {
					toolbar.insertBefore(separator, insertBefore);
				}
				else {
					toolbar.appendChild(separator);
				}
			}
			if (insertBefore) {
				toolbar.insertBefore(button, insertBefore);
			}
			else {
				toolbar.appendChild(button);
			}
			return;
		}
		let divider = Array.from(toolbar.children || []).find((child) => {
			let name = String(child.localName || "").toLowerCase();
			if (["spacer", "spring", "toolbarspacer", "toolbarspacer"].includes(name)) return true;
			let flex = child.getAttribute?.("flex");
			return flex && flex !== "0";
		});
		if (divider) {
			if (separator) {
				toolbar.insertBefore(separator, divider);
			}
			toolbar.insertBefore(button, divider);
			return;
		}
		if (separator) {
			toolbar.appendChild(separator);
		}
		toolbar.appendChild(button);
	},

	buildViewUI(doc) {
		let root = this.html(doc, "div", { className: "zc-pane-root" });

		let header = this.html(doc, "div", { className: "zc-pane-header" });
		let sessionRow = this.html(doc, "div", { className: "zc-pane-session-row" });
		let profileSettingsButton = this.html(doc, "button", {
			className: "zc-btn zc-btn-ghost zc-icon-button zc-profile-settings-button",
			type: "button",
			title: "打开供应商、模型和系统提示词设置",
			"aria-label": "打开供应商、模型和系统提示词设置"
		});
		sessionRow.appendChild(profileSettingsButton);
		let sessionSelect = this.html(doc, "select", {
			className: "zc-session-select",
			title: "选择会话"
		});
		sessionRow.appendChild(sessionSelect);
		let actionsRow = this.html(doc, "div", { className: "zc-pane-actions" });
		let manageGroup = this.html(doc, "div", { className: "zc-pane-actions-group" });
		let renameButton = this.html(doc, "button", {
			className: "zc-btn zc-btn-ghost",
			type: "button",
			textContent: "Rename"
		});
		let newChatButton = this.html(doc, "button", {
			className: "zc-btn zc-btn-ghost",
			type: "button",
			textContent: "New Chat"
		});
		let deleteButton = this.html(doc, "button", {
			className: "zc-btn zc-btn-ghost zc-btn-danger",
			type: "button",
			textContent: "Delete"
		});
		let copyConversationButton = this.html(doc, "button", {
			className: "zc-btn zc-btn-ghost",
			type: "button",
			textContent: "Duplicate"
		});
		manageGroup.appendChild(renameButton);
		manageGroup.appendChild(copyConversationButton);
		manageGroup.appendChild(deleteButton);
		actionsRow.appendChild(manageGroup);
		actionsRow.appendChild(newChatButton);
		header.appendChild(sessionRow);
		header.appendChild(actionsRow);
		root.appendChild(header);

		let status = this.html(doc, "div", { className: "zc-status" });
		root.appendChild(status);

		let messagesWrap = this.html(doc, "div", { className: "zc-messages-wrap" });
		let emptyState = this.html(doc, "div", {
			className: "zc-empty-state",
			textContent: "拖拽条目到输入框，添加上下文后开始提问。"
		});
		let messages = this.html(doc, "div", { className: "zc-messages" });
		messagesWrap.appendChild(emptyState);
		messagesWrap.appendChild(messages);
		root.appendChild(messagesWrap);

		let composerResizeBar = this.html(doc, "div", {
			className: "zc-composer-resizebar",
			title: "拖动调整输入框高度"
		});
		root.appendChild(composerResizeBar);

		let composer = this.html(doc, "div", { className: "zc-composer" });
		let composerSources = this.html(doc, "div", { className: "zc-source-list zc-composer-sources" });
		let composerProfileRow = this.html(doc, "div", { className: "zc-composer-profile-row" });
		let inputWrap = this.html(doc, "div", { className: "zc-input-wrap" });
		let input = this.html(doc, "textarea", {
			className: "zc-input",
			placeholder: "输入问题，或把条目拖到这里。Enter 发送，Shift+Enter 换行。",
			rows: "5"
		});
		inputWrap.appendChild(input);
		let composerFooter = this.html(doc, "div", { className: "zc-composer-footer" });
		let contextButtonWrap = this.html(doc, "div", { className: "zc-context-button-wrap" });
		let contextButton = this.html(doc, "button", {
			className: "zc-btn zc-btn-ghost zc-context-button",
			type: "button",
			title: "添加 PDF 上下文",
			"aria-label": "添加 PDF 上下文"
		});
		let contextButtonGlyph = this.createPlusIcon(doc);
		contextButton.appendChild(contextButtonGlyph);
		let contextMenu = this.html(doc, "div", {
			className: "zc-context-menu",
			hidden: "hidden"
		});
		let contextMenuList = this.html(doc, "div", { className: "zc-context-menu-list" });
		contextMenu.appendChild(contextMenuList);
		contextButtonWrap.appendChild(contextButton);
		contextButtonWrap.appendChild(contextMenu);
		let profileControls = this.html(doc, "div", { className: "zc-profile-controls" });
		let profileSelect = this.html(doc, "select", {
			className: "zc-profile-select",
			title: "选择模型"
		});
		profileControls.appendChild(profileSelect);
		let promptControls = this.html(doc, "div", { className: "zc-prompt-controls" });
		let promptSelect = this.html(doc, "select", {
			className: "zc-profile-select zc-prompt-select",
			title: "选择系统提示词"
		});
		promptControls.appendChild(promptSelect);
		composerProfileRow.appendChild(profileControls);
		composerProfileRow.appendChild(promptControls);
		let cancelEditButton = this.html(doc, "button", {
			className: "zc-btn zc-btn-ghost zc-cancel-edit",
			type: "button",
			textContent: "Cancel"
		});
		let regenerateButton = this.html(doc, "button", {
			className: "zc-btn zc-btn-ghost zc-regenerate-edit",
			type: "button",
			textContent: "Regenerate"
		});
		let stopButton = this.html(doc, "button", {
			className: "zc-btn zc-btn-ghost zc-stop-generate",
			type: "button",
			textContent: "Stop"
		});
		let composerSubmit = this.html(doc, "div", { className: "zc-composer-submit" });
		let composerSecondaryActions = this.html(doc, "div", { className: "zc-composer-secondary-actions" });
		let sendButton = this.html(doc, "button", {
			className: "zc-btn zc-btn-primary",
			type: "button",
			textContent: "Send"
		});
		let sendLabel = this.html(doc, "span", {
			className: "zc-send-label",
			textContent: "Send"
		});
		sendButton.textContent = "";
		sendButton.appendChild(sendLabel);
		composerSecondaryActions.appendChild(cancelEditButton);
		composerSecondaryActions.appendChild(regenerateButton);
		composerSecondaryActions.appendChild(stopButton);
		composerFooter.appendChild(contextButtonWrap);
		composerSubmit.appendChild(composerSecondaryActions);
		composerSubmit.appendChild(sendButton);
		composerFooter.appendChild(composerSubmit);
		composer.appendChild(composerSources);
		composer.appendChild(composerProfileRow);
		composer.appendChild(inputWrap);
		composer.appendChild(composerFooter);
		root.appendChild(composer);

		return {
			root,
			sessionSelect,
			renameButton,
			newChatButton,
			copyConversationButton,
			deleteButton,
			status,
			emptyState,
			messages,
			composerResizeBar,
			composerSources,
			contextButtonWrap,
			inputWrap,
			input,
			contextButton,
			contextButtonGlyph,
			contextMenu,
			contextMenuList,
			profileSelect,
			promptSelect,
			profileSettingsButton,
			cancelEditButton,
			regenerateButton,
			stopButton,
			composerSecondaryActions,
			sendButton,
			sendLabel,
			composerProfileRow
		};
	},

	attachViewListeners(state) {
		state.onToolbarButtonClick = () => {
			this.refreshCurrentItemFromSelection(state);
			this.setSidebarOpen(state, !state.isOpen);
		};
		this.bindToolbarToggleButton(state, state.toolbarButton);

		state.onNewChatClick = () => this.handleNewChat(state).catch((e) => this.handleStateError(state, "新建会话失败", e));
		state.newChatButton.addEventListener("click", state.onNewChatClick);
		state.onRenameClick = () => this.handleRenameCurrentSession(state).catch((e) => this.handleStateError(state, "重命名会话失败", e));
		state.renameButton.addEventListener("click", state.onRenameClick);
		state.onCopyConversationClick = () => this.handleCloneCurrentSession(state).catch((e) => this.handleStateError(state, "复制会话失败", e));
		state.copyConversationButton.addEventListener("click", state.onCopyConversationClick);
		state.onDeleteClick = () => this.handleDeleteCurrentSession(state).catch((e) => this.handleStateError(state, "删除会话失败", e));
		state.deleteButton.addEventListener("click", state.onDeleteClick);

		state.onSessionSelectChange = (event) => {
			let control = event.currentTarget || event.target || state.sessionSelect;
			let sessionID = String(control?.value || "").trim();
			if (!sessionID) return;
			if (sessionID === state.currentSession?.data?.sessionID) return;
			this.switchToSession(state, sessionID).catch((e) => this.handleStateError(state, "切换会话失败", e));
		};
		state.sessionSelect.addEventListener("change", state.onSessionSelectChange);
		state.onProfileSelectChange = (event) => {
			let control = event.currentTarget || event.target || state.profileSelect;
			let profileID = String(control?.value || "").trim();
			if (!profileID) return;
			this.selectProfile(state, profileID);
		};
		state.profileSelect.addEventListener("change", state.onProfileSelectChange);
		state.onPromptSelectChange = (event) => {
			let control = event.currentTarget || event.target || state.promptSelect;
			let promptID = String(control?.value || "").trim();
			this.selectSystemPrompt(state, promptID);
		};
		state.promptSelect.addEventListener("change", state.onPromptSelectChange);
		state.onProfileSettingsClick = () => this.openSettingsPane(state);
		state.profileSettingsButton.addEventListener("click", state.onProfileSettingsClick);

		state.onSendClick = () => this.handleSend(state).catch((e) => this.handleStateError(state, "发送失败", e));
		state.sendButton.addEventListener("click", state.onSendClick);
		state.onRegenerateClick = () => this.handleRegenerate(state).catch((e) => this.handleStateError(state, "重新生成失败", e));
		state.regenerateButton.addEventListener("click", state.onRegenerateClick);
		state.onCancelEditClick = () => this.cancelEdit(state);
		state.cancelEditButton.addEventListener("click", state.onCancelEditClick);
		state.onStopClick = () => this.handleStopGeneration(state);
		state.stopButton.addEventListener("click", state.onStopClick);

		state.onInputKeydown = (event) => {
			if (event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
				this.handleSend(state).catch((e) => this.handleStateError(state, "发送失败", e));
			}
		};
		state.input.addEventListener("keydown", state.onInputKeydown);
		state.onContextButtonClick = (event) => {
			this.handleContextButtonClick(state, event).catch((e) => this.handleStateError(state, "打开上下文菜单失败", e));
		};
		state.contextButton.addEventListener("click", state.onContextButtonClick);
		state.onContextMenuClick = (event) => {
			let target = event.target?.closest?.(".zc-context-menu-item");
			if (!target) return;
			let actionID = String(target.dataset.actionId || "").trim();
			if (!actionID) return;
			this.activateContextMenuAction(state, actionID).catch((e) => this.handleStateError(state, "添加上下文失败", e));
		};
		state.contextMenuList.addEventListener("click", state.onContextMenuClick);
		state.onContextMenuPointerDown = (event) => {
			let target = event.target?.closest?.(".zc-context-menu-item");
			if (!target) return;
			event.preventDefault();
			event.stopPropagation();
			let actionID = String(target.dataset.actionId || "").trim();
			if (!actionID) return;
			this.activateContextMenuAction(state, actionID).catch((e) => this.handleStateError(state, "添加上下文失败", e));
		};
		state.contextMenuList.addEventListener("pointerdown", state.onContextMenuPointerDown);
		state.onResizePointerDown = (event) => {
			event.preventDefault();
			state.resizePointerId = event.pointerId;
			state.resizeStartY = event.clientY;
			state.resizeStartHeight = state.input.offsetHeight;
			state.composerResizeBar.setPointerCapture?.(event.pointerId);
		};
		state.onResizePointerMove = (event) => {
			if (state.resizePointerId !== event.pointerId) return;
			let nextHeight = Math.max(96, state.resizeStartHeight + (state.resizeStartY - event.clientY));
			state.input.style.height = `${nextHeight}px`;
		};
		state.onResizePointerUp = (event) => {
			if (state.resizePointerId !== event.pointerId) return;
			state.resizePointerId = null;
			state.composerResizeBar.releasePointerCapture?.(event.pointerId);
		};
		state.composerResizeBar.addEventListener("pointerdown", state.onResizePointerDown);
		state.composerResizeBar.addEventListener("pointermove", state.onResizePointerMove);
		state.composerResizeBar.addEventListener("pointerup", state.onResizePointerUp);
		state.composerResizeBar.addEventListener("pointercancel", state.onResizePointerUp);
		state.onMessagesClick = (event) => {
			let target = event.target?.closest?.(".zc-message-action");
			if (target) {
				let action = target.dataset.action;
				let messageID = target.dataset.messageId;
				if (!action || !messageID) return;
				this.handleMessageAction(state, action, messageID).catch((e) => this.handleStateError(state, "消息操作失败", e));
				return;
			}
			let sourceChip = event.target?.closest?.(".zc-source-jump");
			if (!sourceChip) return;
			this.jumpToSourceRef({
				libraryID: parseInt(sourceChip.dataset.libraryId || "", 10),
				itemKey: sourceChip.dataset.itemKey || "",
				parentItemKey: sourceChip.dataset.parentItemKey || ""
			}, state.window);
		};
		state.messages.addEventListener("click", state.onMessagesClick);
		state.onMessagesCopy = (event) => this.handleMessagesCopy(state, event);
		state.messages.addEventListener("copy", state.onMessagesCopy);
		state.onComposerSourcesClick = (event) => {
			let remove = event.target?.closest?.(".zc-chip-remove");
			if (remove) return;
			let sourceChip = event.target?.closest?.(".zc-source-jump");
			if (!sourceChip) return;
			this.jumpToSourceRef({
				libraryID: parseInt(sourceChip.dataset.libraryId || "", 10),
				itemKey: sourceChip.dataset.itemKey || "",
				parentItemKey: sourceChip.dataset.parentItemKey || ""
			}, state.window);
		};
		state.composerSources.addEventListener("click", state.onComposerSourcesClick);

		state.onDragEnter = (event) => {
			if (!this.canAcceptDrop(state.window, event, { allowSelectionFallback: true })) return;
			event.preventDefault();
			state.input.classList.add("is-dragging");
		};
		state.onDragOver = (event) => {
			if (!this.canAcceptDrop(state.window, event, { allowSelectionFallback: true })) return;
			event.preventDefault();
			event.dataTransfer.dropEffect = "copy";
			state.input.classList.add("is-dragging");
		};
		state.onDragLeave = () => state.input.classList.remove("is-dragging");
		state.onDrop = (event) => {
			if (!this.canAcceptDrop(state.window, event, { allowSelectionFallback: true })) return;
			event.preventDefault();
			state.input.classList.remove("is-dragging");
			this.setSidebarOpen(state, true);
			this.handleDrop(state, event).catch((e) => this.handleStateError(state, "添加上下文失败", e));
		};
		for (let [name, fn] of [["dragenter", state.onDragEnter], ["dragover", state.onDragOver], ["dragleave", state.onDragLeave], ["drop", state.onDrop]]) {
			state.input.addEventListener(name, fn);
		}

		state.onWindowFocus = () => {
			this.refreshCurrentItemFromSelection(state);
			this.renderProfileMenu(state);
			this.renderPromptMenu(state);
			this.renderSessionMenu(state);
			this.updateContextButtonVisibility(state);
		};
		state.window.addEventListener("focus", state.onWindowFocus, true);
		state.onDocumentClick = (event) => {
			if (!this.isEventInside(event, ".zc-context-button-wrap")) {
				this.hideContextMenu(state);
			}
			if (state.isProfileMenuOpen && !this.isEventInside(event, ".zc-profile-menu") && !this.isEventInside(event, ".zc-profile-button")) {
				this.hideProfileMenu(state);
			}
		};
		state.doc.addEventListener("click", state.onDocumentClick);
		state.onWindowBlur = () => {
			this.hideContextMenu(state);
			this.hideProfileMenu(state);
		};
		state.window.addEventListener("blur", state.onWindowBlur, true);
		this.updateContextButtonVisibility(state);
	},

	detachViewListeners(state) {
		this.unbindToolbarToggleButton(state, state.toolbarButton);
		state.newChatButton?.removeEventListener("click", state.onNewChatClick);
		state.renameButton?.removeEventListener("click", state.onRenameClick);
		state.copyConversationButton?.removeEventListener("click", state.onCopyConversationClick);
		state.deleteButton?.removeEventListener("click", state.onDeleteClick);
		state.sessionSelect?.removeEventListener("change", state.onSessionSelectChange);
		state.profileSelect?.removeEventListener("change", state.onProfileSelectChange);
		state.promptSelect?.removeEventListener("change", state.onPromptSelectChange);
		state.profileSettingsButton?.removeEventListener("click", state.onProfileSettingsClick);
		state.sendButton?.removeEventListener("click", state.onSendClick);
		state.regenerateButton?.removeEventListener("click", state.onRegenerateClick);
		state.cancelEditButton?.removeEventListener("click", state.onCancelEditClick);
		state.stopButton?.removeEventListener("click", state.onStopClick);
		state.input?.removeEventListener("keydown", state.onInputKeydown);
		state.contextButton?.removeEventListener("click", state.onContextButtonClick);
		state.contextMenuList?.removeEventListener("click", state.onContextMenuClick);
		state.contextMenuList?.removeEventListener("pointerdown", state.onContextMenuPointerDown);
		state.composerResizeBar?.removeEventListener("pointerdown", state.onResizePointerDown);
		state.composerResizeBar?.removeEventListener("pointermove", state.onResizePointerMove);
		state.composerResizeBar?.removeEventListener("pointerup", state.onResizePointerUp);
		state.composerResizeBar?.removeEventListener("pointercancel", state.onResizePointerUp);
		state.messages?.removeEventListener("click", state.onMessagesClick);
		state.messages?.removeEventListener("copy", state.onMessagesCopy);
		state.composerSources?.removeEventListener("click", state.onComposerSourcesClick);
		state.window?.removeEventListener("focus", state.onWindowFocus, true);
		state.doc?.removeEventListener("click", state.onDocumentClick);
		state.window?.removeEventListener("blur", state.onWindowBlur, true);
		for (let [name, fn] of [["dragenter", state.onDragEnter], ["dragover", state.onDragOver], ["dragleave", state.onDragLeave], ["drop", state.onDrop]]) {
			state.input?.removeEventListener(name, fn);
		}
	},

	getSelectedItem(window) {
		try {
			return window?.ZoteroPane?.getSelectedItems?.()?.[0] || null;
		}
		catch (_e) {
			return null;
		}
	},

	refreshCurrentItemFromSelection(state) {
		state.currentItem = this.getSelectedItem(state.window) || this.getCurrentReaderContextItem(state.window);
	},

	setSidebarOpen(state, isOpen) {
		state.isOpen = !!isOpen;
		this.setBoolPref("sidebarOpen", state.isOpen);
		state.panel.hidden = !state.isOpen;
		state.splitter.hidden = !state.isOpen;
		state.panel.collapsed = !state.isOpen;
		state.splitter.collapsed = !state.isOpen;
		if (state.panel.style) {
			state.panel.style.display = state.isOpen ? "" : "none";
		}
		if (state.splitter.style) {
			state.splitter.style.display = state.isOpen ? "" : "none";
		}
		this.updateToolbarButtons(state);
		if (state.isOpen) {
			this.refreshCurrentItemFromSelection(state);
			this.renderProfileMenu(state);
			this.renderSessionMenu(state);
			this.updateContextButtonVisibility(state);
		}
	},

	bindToolbarToggleButton(state, button) {
		if (!button) return;
		button.oncommand = state.onToolbarButtonClick;
		button.addEventListener("command", state.onToolbarButtonClick);
		button.addEventListener("click", state.onToolbarButtonClick);
		button.addEventListener("mouseup", state.onToolbarButtonClick);
	},

	unbindToolbarToggleButton(state, button) {
		if (!button) return;
		button.removeEventListener("command", state.onToolbarButtonClick);
		button.removeEventListener("click", state.onToolbarButtonClick);
		button.removeEventListener("mouseup", state.onToolbarButtonClick);
		button.oncommand = null;
	},

	updateToolbarButtons(state) {
		for (let button of [state.toolbarButton]) {
			if (!button) continue;
			button.classList.toggle("is-checked", state.isOpen);
			button.setAttribute("aria-pressed", state.isOpen ? "true" : "false");
		}
	},

	getCurrentReaderContextItem(window) {
		let attachment = this.getCurrentReaderPDFAttachment(window);
		if (attachment) return attachment;
		return null;
	},

	getCurrentReaderPDFAttachment(window) {
		let item = null;
		try {
			let tabs = window?.Zotero_Tabs || null;
			let selectedTabID = tabs?.selectedID || tabs?._selectedID || tabs?.selectedTabID || tabs?.selectedTab?.id || null;
			let readerAPI = Zotero.Reader || window?.Zotero?.Reader || null;
			let reader = selectedTabID && readerAPI?.getByTabID ? readerAPI.getByTabID(selectedTabID) : null;
			let tab = null;
			if (!reader && tabs) {
				tab = tabs.getTab?.(selectedTabID) || tabs._getTab?.(selectedTabID) || tabs.selectedTab || null;
				reader = tab?.reader || tab?.data?.reader || null;
			}
			let itemID = reader?.itemID || reader?.item?.id || reader?._item?.id || reader?.data?.itemID || tab?.itemID || tab?.data?.itemID || null;
			if (itemID) {
				item = Zotero.Items.get(itemID);
			}
		}
		catch (_e) {}
		if (item?.isPDFAttachment?.()) return item;
		if (item?.isRegularItem?.()) return this.findFirstPDFAttachment(item);
		return null;
	},

	async handleContextButtonClick(state, event) {
		event.preventDefault();
		if (!state.contextMenu.hidden) {
			this.hideContextMenu(state);
			return;
		}
		let actions = await this.getContextMenuActions(state);
		if (!actions.length) {
			this.hideContextMenu(state);
			this.setStatus(state, "当前不在 PDF 阅读页面，无法添加 PDF 上下文", true);
			return;
		}
		this.renderContextMenu(state, actions);
	},

	updateContextButtonVisibility(state) {
		let isVisible = !!this.getCurrentReaderPDFAttachment(state.window);
		if (state.contextButtonWrap) {
			state.contextButtonWrap.hidden = !isVisible;
		}
		if (!isVisible) {
			this.hideContextMenu(state);
		}
	},

	async getContextMenuActions(state) {
		let actions = [];
		let pdfAttachment = this.getCurrentReaderPDFAttachment(state.window);
		if (!pdfAttachment?.isPDFAttachment?.()) {
			return actions;
		}
		let parentItem = pdfAttachment.parentItemID ? Zotero.Items.get(pdfAttachment.parentItemID) : null;
		if (pdfAttachment?.isPDFAttachment?.()) {
			actions.push({
				id: "current-pdf",
				label: "将当前 PDF 添加到上下文",
				items: [pdfAttachment]
			});
		}
		let mineruParent = parentItem || (pdfAttachment?.parentItemID ? Zotero.Items.get(pdfAttachment.parentItemID) : null);
		let mineruAttachment = mineruParent ? this.findMineruMarkdownAttachment(mineruParent) : null;
		if (mineruParent && mineruAttachment) {
			actions.push({
				id: "mineru-markdown",
				label: "将 MinerU 解析结果添加到上下文",
				items: [mineruAttachment]
			});
		}
		return actions;
	},

	renderContextMenu(state, actions) {
		state.contextMenuActions = actions;
		state.contextMenuList.textContent = "";
		for (let action of actions) {
			let button = this.html(state.doc, "button", {
				className: "zc-context-menu-item",
				type: "button"
			});
			button.dataset.actionId = action.id;
			button.textContent = action.label;
			state.contextMenuList.appendChild(button);
		}
		state.contextMenu.hidden = false;
	},

	hideContextMenu(state) {
		if (!state?.contextMenu) return;
		state.contextMenu.hidden = true;
		state.contextMenuActions = [];
	},

	async activateContextMenuAction(state, actionID) {
		let action = (state.contextMenuActions || []).find((entry) => entry.id === actionID);
		this.hideContextMenu(state);
		if (!action) return;
		if (Array.isArray(action.items) && action.items.length) {
			let beforeCount = (state.pendingSourceRefs || []).length;
			await this.addPendingItemsToComposer(state, action.items);
			let afterCount = (state.pendingSourceRefs || []).length;
			if (afterCount <= beforeCount) {
				this.setStatus(state, "当前 PDF 上下文未成功添加，请检查 PDF 文本是否可提取", true);
			}
			this.inputFocus(state);
			return;
		}
		if (!action.run) return;
		let result = await action.run();
		if (!result?.ok || !result.sourceRef) {
			this.setStatus(state, result?.reason || "无法添加当前上下文", true);
			return;
		}
		this.addPendingSourceRef(state, result.sourceRef);
		this.setStatus(state, `已添加上下文：${result.sourceRef.label}`);
		this.inputFocus(state);
	},

	addPendingSourceRef(state, sourceRef) {
		if (!sourceRef) return;
		if ((state.pendingSourceRefs || []).some((entry) => entry.sourceID === sourceRef.sourceID)) return;
		state.pendingSourceRefs.push(sourceRef);
		this.renderPendingSources(state);
	},

	handleStateError(state, prefix, error) {
		Zotero.logError(error);
		this.setStatus(state, `${prefix}：${error.message || error}`, true);
	},

	setStatus(state, message, isError = false) {
		state.status.textContent = message || "";
		state.status.classList.toggle("is-error", !!isError);
	},

	updateSendButton(state) {
		let isEditing = !!state.editTargetMessageID;
		let isEditingUser = isEditing && state.editTargetRole === "user";
		state.sendLabel.textContent = isEditing ? "Save" : "Send";
		state.sendButton.setAttribute("title", isEditing ? "保存当前消息修改" : "发送");
		state.sessionSelect.disabled = !!state.isSending;
		state.cancelEditButton.style.display = isEditing ? "" : "none";
		state.regenerateButton.style.display = isEditingUser ? "" : "none";
		state.regenerateButton.disabled = !isEditingUser;
		state.stopButton.style.display = state.isSending ? "" : "none";
		state.stopButton.disabled = !state.isSending;
	},

	inputFocus(state) {
		state.input.focus();
		let end = state.input.value.length;
		state.input.setSelectionRange?.(end, end);
	},

	cancelEdit(state) {
		state.editTargetMessageID = null;
		state.editTargetRole = null;
		state.pendingSourceRefs = [];
		state.input.value = "";
		this.renderPendingSources(state);
		this.renderMessages(state, state.currentSession?.data?.messages || []);
		this.updateSendButton(state);
		this.setStatus(state, "已取消编辑");
	},

	handleStopGeneration(state) {
		if (!state.isSending) return;
		state.stopRequested = true;
		state.stopButton.disabled = true;
		this.finalizeStoppedRequest(state).catch((e) => this.handleStateError(state, "停止生成失败", e));
		try {
			state.requestAbortController?.abort?.();
		}
		catch (_e) {}
		try {
			state.currentStreamReader?.cancel?.();
		}
		catch (_e) {}
		this.setStatus(state, "正在停止生成...");
	},

	async finalizeStoppedRequest(state) {
		let active = state.currentStreaming;
		if (!active || active.finalized) return;
		active.finalized = true;
		state.activeRequestID = null;
		if (active.streaming?.stopWaiting) {
			active.streaming.stopWaiting();
		}
		this.cancelStreamingRender(state, active.streaming?.contentRender);
		this.cancelStreamingRender(state, active.streaming?.reasoningRender);
		if (active.streaming?.node?.isConnected) {
			active.streaming.node.remove();
		}
		if (active.streaming?.message && (active.streaming.message.reasoning || active.streaming.message.content)) {
			active.streaming.message.stopped = true;
			active.streaming.message.stoppedAt = new Date().toISOString();
			active.session.data.messages.push(active.streaming.message);
		}
		active.session.data.updatedAt = new Date().toISOString();
		await this.saveSession(active.session);
		state.currentStreaming = null;
		state.isSending = false;
		state.requestAbortController = null;
		state.currentStreamReader = null;
		state.sendButton.disabled = false;
		state.input.disabled = false;
		this.updateSendButton(state);
		this.renderCurrentSession(state);
		this.setStatus(state, "已停止生成");
	},

	jumpToSourceRef(sourceRef, window) {
		let libraryID = Number.isFinite(sourceRef.libraryID) ? sourceRef.libraryID : null;
		let itemKey = sourceRef.itemKey || sourceRef.parentItemKey;
		if (!libraryID || !itemKey) return;
		let item = Zotero.Items.getByLibraryAndKey?.(libraryID, itemKey);
		if (!item && sourceRef.parentItemKey) {
			item = Zotero.Items.getByLibraryAndKey?.(libraryID, sourceRef.parentItemKey);
		}
		if (!item) return;
		try {
			window.ZoteroPane?.selectItem?.(item.id);
		}
		catch (_e) {}
	},

	html(doc, tag, options = {}) {
		let el = doc.createElementNS(this.HTML_NS, tag);
		for (let [key, value] of Object.entries(options)) {
			if (value === undefined || value === null) continue;
			if (key === "className") el.className = value;
			else if (key === "textContent") el.textContent = value;
			else el.setAttribute(key, value);
		}
		return el;
	},

	createPlusIcon(doc) {
		let svg = doc.createElementNS(this.SVG_NS, "svg");
		svg.setAttribute("class", "zc-context-button-glyph");
		svg.setAttribute("viewBox", "0 0 20 20");
		svg.setAttribute("width", "14");
		svg.setAttribute("height", "14");
		svg.setAttribute("focusable", "false");
		svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
		svg.setAttribute("aria-hidden", "true");
		let path = doc.createElementNS(this.SVG_NS, "path");
		path.setAttribute("fill", "currentColor");
		path.setAttribute("d", "M9.25 4.25a.75.75 0 0 1 1.5 0v5h5a.75.75 0 0 1 0 1.5h-5v5a.75.75 0 0 1-1.5 0v-5h-5a.75.75 0 0 1 0-1.5h5v-5Z");
		svg.appendChild(path);
		return svg;
	},

	createSelectOption(doc, label, value) {
		let option = this.html(doc, "option", { value: String(value || "") });
		option.textContent = label;
		return option;
	},

	xul(doc, tag, options = {}) {
		let el = doc.createXULElement?.(tag) || doc.createElement(tag);
		for (let [key, value] of Object.entries(options)) {
			if (value === undefined || value === null) continue;
			if (key === "textContent") el.textContent = value;
			else el.setAttribute(key, value);
		}
		return el;
	},

	findEventMatch(event, selector) {
		if (!event || !selector) return null;
		let target = event.target;
		if (target?.nodeType !== 1) {
			target = target?.parentElement || null;
		}
		if (target?.closest) {
			let match = target.closest(selector);
			if (match) return match;
		}
		let path = typeof event.composedPath === "function" ? event.composedPath() : [];
		for (let node of path) {
			if (node?.nodeType !== 1) continue;
			if (node.matches?.(selector)) return node;
		}
		return null;
	},

	isEventInside(event, selector) {
		return !!this.findEventMatch(event, selector);
	},

	getMenuOptionSessionID(target) {
		return String(target?.dataset?.sessionId || "").trim();
	},

	handleSessionOptionActivation(state, eventOrTarget, explicitSessionID = "") {
		let option = explicitSessionID ? null : this.findEventMatch(eventOrTarget, ".zc-session-option");
		let sessionID = String(explicitSessionID || this.getMenuOptionSessionID(option)).trim();
		if (!sessionID) return;
		eventOrTarget?.preventDefault?.();
		eventOrTarget?.stopPropagation?.();
		this.switchToSession(state, sessionID).catch((e) => this.handleStateError(state, "切换会话失败", e));
	},

	setMarkdownContent(el, markdownText) {
		if (!el) return;
		let source = this.sanitizeDOMString(markdownText);
		el.dataset.markdownSource = source;
		if (!source) {
			el.classList.remove("zc-markdown-fallback");
			this.replaceNodeChildren(el, []);
			return;
		}
		try {
			el.classList.remove("zc-markdown-fallback");
			let nodes = this.buildMarkdownNodes(el.ownerDocument, source);
			this.postProcessFormulaNodes(el.ownerDocument, nodes);
			this.replaceNodeChildren(el, nodes);
		}
		catch (_e) {
			el.classList.add("zc-markdown-fallback");
			this.replaceNodeChildren(el, [el.ownerDocument.createTextNode(source)]);
		}
	},

	setRenderedHTML(el, html) {
		let doc = el.ownerDocument;
		let fragment = doc.createDocumentFragment();
		for (let node of this.parseHTMLToNodes(doc, html)) {
			fragment.appendChild(node);
		}
		this.replaceNodeChildren(el, Array.from(fragment.childNodes || []));
	},

	replaceNodeChildren(el, nodes) {
		while (el.firstChild) {
			el.removeChild(el.firstChild);
		}
		for (let node of nodes || []) {
			el.appendChild(node);
		}
	},

	now(window = null) {
		let perf = window?.performance || globalThis.performance;
		return typeof perf?.now === "function" ? perf.now() : Date.now();
	},

	isNearBottom(scroller, threshold = this.STREAM_AUTO_SCROLL_THRESHOLD_PX) {
		if (!scroller) return true;
		return Math.max(0, scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight) <= threshold;
	},

	scrollMessagesToBottom(state, { force = false } = {}) {
		if (!state?.messages) return;
		if (!force && !this.isNearBottom(state.messages)) return;
		state.messages.scrollTop = state.messages.scrollHeight;
	},

	createStreamingRenderState(rootEl) {
		return {
			rootEl,
			pendingText: "",
			renderedStable: null,
			renderedTail: null,
			lastFlushAt: 0,
			rafHandle: 0,
			timerHandle: 0,
			tailEl: null,
			degraded: false
		};
	},

	cancelStreamingRender(state, renderState) {
		if (!renderState) return;
		let win = state?.window;
		if (renderState.rafHandle) {
			if (typeof win?.cancelAnimationFrame === "function") {
				win.cancelAnimationFrame(renderState.rafHandle);
			}
			else {
				win?.clearTimeout?.(renderState.rafHandle);
			}
			renderState.rafHandle = 0;
		}
		if (renderState.timerHandle) {
			win?.clearTimeout?.(renderState.timerHandle);
			renderState.timerHandle = 0;
		}
	},

	syncStreamingTail(renderState, tailText) {
		let text = String(tailText || "");
		if (renderState.renderedTail === text) return;
		renderState.renderedTail = text;
		if (!text) {
			renderState.tailEl?.remove?.();
			renderState.tailEl = null;
			return;
		}
		if (!renderState.tailEl || !renderState.tailEl.isConnected) {
			renderState.tailEl = this.html(renderState.rootEl.ownerDocument, "div", {
				className: "zc-stream-tail"
			});
			renderState.rootEl.appendChild(renderState.tailEl);
		}
		renderState.tailEl.textContent = text;
	},

	findStreamingStableBoundary(text) {
		let source = String(text || "").replace(/\r\n?/g, "\n");
		if (!source) return 0;
		let lines = source.split("\n");
		let offset = 0;
		let lastSafe = 0;
		let inFence = false;
		let inMathBlock = false;
		let fenceStart = 0;
		let mathStart = 0;
		for (let i = 0; i < lines.length; i++) {
			let line = lines[i];
			let lineStart = offset;
			let lineEnd = lineStart + line.length + (i < lines.length - 1 ? 1 : 0);
			let trimmed = line.trim();
			if (/^```/.test(trimmed)) {
				if (!inFence) {
					inFence = true;
					fenceStart = lineStart;
				}
				else {
					inFence = false;
					lastSafe = lineEnd;
				}
			}
			else if (/^\$\$\s*$/.test(trimmed)) {
				if (!inMathBlock) {
					inMathBlock = true;
					mathStart = lineStart;
				}
				else {
					inMathBlock = false;
					lastSafe = lineEnd;
				}
			}
			else if (!inFence && !inMathBlock) {
				if (!trimmed) {
					lastSafe = lineEnd;
				}
				else if (/^(#{1,6}\s|>\s?|[-*+]\s|\d+\.\s)/.test(line)) {
					lastSafe = lineEnd;
				}
			}
			offset = lineEnd;
		}
		if (inFence) {
			lastSafe = Math.min(lastSafe || fenceStart, fenceStart);
		}
		if (inMathBlock) {
			lastSafe = Math.min(lastSafe || mathStart, mathStart);
		}
		if (!inFence && !inMathBlock && source.length <= this.STREAM_RENDER_DEGRADE_THRESHOLD) {
			return source.length;
		}
		return Math.max(0, Math.min(lastSafe, source.length));
	},

	splitStreamingMarkdown(text, { forceMarkdown = false } = {}) {
		let source = String(text || "");
		if (!source) return { stableText: "", tailText: "" };
		if (forceMarkdown) {
			return { stableText: source, tailText: "" };
		}
		if (source.length > this.STREAM_RENDER_DEGRADE_THRESHOLD) {
			return { stableText: "", tailText: source, degraded: true };
		}
		let boundary = this.findStreamingStableBoundary(source);
		return {
			stableText: source.slice(0, boundary),
			tailText: source.slice(boundary)
		};
	},

	flushStreamingRender(state, renderState, { forceMarkdown = false, forceScroll = false } = {}) {
		if (!renderState?.rootEl) return;
		let shouldStickBottom = forceScroll || this.isNearBottom(state?.messages);
		this.cancelStreamingRender(state, renderState);
		let nextText = String(renderState.pendingText || "");
		let split = this.splitStreamingMarkdown(nextText, { forceMarkdown });
		if (split.degraded) {
			renderState.degraded = true;
		}
		if (renderState.renderedStable !== split.stableText) {
			this.setMarkdownContent(renderState.rootEl, split.stableText);
			renderState.tailEl = null;
			renderState.renderedStable = split.stableText;
			renderState.renderedTail = null;
		}
		this.syncStreamingTail(renderState, split.tailText);
		renderState.lastFlushAt = this.now(state?.window);
		this.scrollMessagesToBottom(state, { force: shouldStickBottom });
	},

	scheduleStreamingRender(state, renderState) {
		if (!renderState?.rootEl) return;
		if (renderState.rafHandle || renderState.timerHandle) return;
		let win = state?.window;
		let now = this.now(win);
		let wait = Math.max(0, this.STREAM_RENDER_INTERVAL_MS - (now - renderState.lastFlushAt));
		let queueFlush = () => {
			if (typeof win?.requestAnimationFrame === "function") {
				renderState.rafHandle = win.requestAnimationFrame(() => {
					renderState.rafHandle = 0;
					this.flushStreamingRender(state, renderState);
				});
				return;
			}
			renderState.timerHandle = win?.setTimeout?.(() => {
				renderState.timerHandle = 0;
				this.flushStreamingRender(state, renderState);
			}, 0) || 0;
		};
		if (wait > 0) {
			renderState.timerHandle = win?.setTimeout?.(() => {
				renderState.timerHandle = 0;
				queueFlush();
			}, wait) || 0;
			return;
		}
		queueFlush();
	},

	updateStreamingText(state, renderState, nextText) {
		if (!renderState) return;
		renderState.pendingText = String(nextText || "");
		this.scheduleStreamingRender(state, renderState);
	},

	finalizeStreamingText(state, renderState, nextText, { forceScroll = false } = {}) {
		if (!renderState) return;
		renderState.pendingText = String(nextText || "");
		this.flushStreamingRender(state, renderState, { forceMarkdown: true, forceScroll });
	},

	buildMarkdownNodes(doc, markdownText, formulas = null) {
		let normalizedText = this.sanitizeDOMString(markdownText).replace(/\r\n?/g, "\n");
		let tokenized = Array.isArray(formulas)
			? { text: normalizedText, formulas }
			: this.tokenizeFormulaPlaceholders(normalizedText);
		let text = tokenized.text;
		let lines = text.split("\n");
		let nodes = [];
		let i = 0;
		let isBlank = (line) => !String(line || "").trim();
		let isCodeFence = (line) => /^```/.test(line);
		let isHeading = (line) => /^(#{1,6})\s+.+$/.test(line);
		let isBlockquote = (line) => /^\s*>\s?/.test(line);
		let isList = (line) => /^(\s*)([-*+]|\d+\.)\s+/.test(line);
		let isDisplayFormula = (line) => /^\s*@@MATHBLOCK\d+@@\s*$/.test(line);

		while (i < lines.length) {
			let line = lines[i];
			if (isBlank(line)) {
				i += 1;
				continue;
			}

			if (isCodeFence(line)) {
				let match = line.match(/^```([^\n`]*)/);
				let lang = String(match?.[1] || "").trim();
				let codeLines = [];
				i += 1;
				while (i < lines.length && !/^```/.test(lines[i])) {
					codeLines.push(lines[i]);
					i += 1;
				}
				if (i < lines.length && /^```/.test(lines[i])) i += 1;
				let pre = doc.createElementNS(this.HTML_NS, "pre");
				let code = doc.createElementNS(this.HTML_NS, "code");
				if (lang) code.setAttribute("data-language", lang);
				code.textContent = codeLines.join("\n");
				pre.appendChild(code);
				nodes.push(pre);
				continue;
			}

			if (isDisplayFormula(line)) {
				let parsed = this.parseDisplayFormulaBlock(lines, i, tokenized.formulas);
				if (parsed) {
					nodes.push(this.buildFormulaNode(doc, parsed.expr, true, parsed.openDelimiter, parsed.closeDelimiter));
					i = parsed.nextIndex;
					continue;
				}
			}

			let headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
			if (headingMatch) {
				let level = headingMatch[1].length;
				let heading = doc.createElementNS(this.HTML_NS, `h${level}`);
				this.appendInlineMarkdownNodes(doc, heading, headingMatch[2], tokenized.formulas);
				nodes.push(heading);
				i += 1;
				continue;
			}

			if (isBlockquote(line)) {
				let quoteLines = [];
				while (i < lines.length && (isBlockquote(lines[i]) || isBlank(lines[i]))) {
					quoteLines.push(lines[i].replace(/^\s*>\s?/, ""));
					i += 1;
				}
				let blockquote = doc.createElementNS(this.HTML_NS, "blockquote");
				for (let child of this.buildMarkdownNodes(doc, quoteLines.join("\n"), tokenized.formulas)) {
					blockquote.appendChild(child);
				}
				nodes.push(blockquote);
				continue;
			}

			if (isList(line)) {
				let parsed = this.parseListBlock(doc, lines, i, tokenized.formulas);
				nodes.push(parsed.node);
				i = parsed.nextIndex;
				continue;
			}

			let paraLines = [];
			while (i < lines.length && !isBlank(lines[i]) && !isCodeFence(lines[i]) && !isHeading(lines[i]) && !isBlockquote(lines[i]) && !isList(lines[i]) && !isDisplayFormula(lines[i])) {
				paraLines.push(lines[i]);
				i += 1;
			}
			if (!paraLines.length) {
				paraLines.push(line);
				i += 1;
			}
			let p = doc.createElementNS(this.HTML_NS, "p");
			this.appendInlineMarkdownNodes(doc, p, paraLines.join("\n"), tokenized.formulas);
			nodes.push(p);
		}

		return nodes;
	},

	parseDisplayFormulaBlock(lines, startIndex, formulas = []) {
		let line = String(lines[startIndex] || "");
		let tokenMatch = line.match(/^\s*@@MATHBLOCK(\d+)@@\s*$/);
		if (tokenMatch) {
			let formula = formulas[parseInt(tokenMatch[1], 10)];
			if (!formula) return null;
			return {
				expr: formula.expr,
				openDelimiter: formula.openDelimiter,
				closeDelimiter: formula.closeDelimiter,
				nextIndex: startIndex + 1
			};
		}
		if (/^\s*\$\$\s*$/.test(line)) {
			let exprLines = [];
			let i = startIndex + 1;
			while (i < lines.length && !/^\s*\$\$\s*$/.test(lines[i])) {
				exprLines.push(lines[i]);
				i += 1;
			}
			if (i < lines.length) {
				return {
					expr: exprLines.join("\n"),
					openDelimiter: "$$",
					closeDelimiter: "$$",
					nextIndex: i + 1
				};
			}
			return null;
		}
		let singleDollar = line.match(/^\s*\$\$([\s\S]+?)\$\$\s*$/);
		if (singleDollar) {
			return {
				expr: singleDollar[1],
				openDelimiter: "$$",
				closeDelimiter: "$$",
				nextIndex: startIndex + 1
			};
		}
		if (/^\s*\\\[\s*$/.test(line)) {
			let exprLines = [];
			let i = startIndex + 1;
			while (i < lines.length && !/^\s*\\\]\s*$/.test(lines[i])) {
				exprLines.push(lines[i]);
				i += 1;
			}
			if (i < lines.length) {
				return {
					expr: exprLines.join("\n"),
					openDelimiter: "\\[",
					closeDelimiter: "\\]",
					nextIndex: i + 1
				};
			}
			return null;
		}
		let singleBracket = line.match(/^\s*\\\[([\s\S]+?)\\\]\s*$/);
		if (singleBracket) {
			return {
				expr: singleBracket[1],
				openDelimiter: "\\[",
				closeDelimiter: "\\]",
				nextIndex: startIndex + 1
			};
		}
		return null;
	},

	parseListBlock(doc, lines, startIndex, formulas = []) {
		let firstMatch = String(lines[startIndex] || "").match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
		let ordered = /\d+\./.test(firstMatch?.[2] || "");
		let list = doc.createElementNS(this.HTML_NS, ordered ? "ol" : "ul");
		let i = startIndex;
		while (i < lines.length) {
			let line = String(lines[i] || "");
			let match = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
			if (!match || /\d+\./.test(match[2]) !== ordered) break;
			let itemLines = [match[3]];
			i += 1;
			while (i < lines.length) {
				let next = String(lines[i] || "");
				if (!next.trim()) {
					itemLines.push("");
					i += 1;
					continue;
				}
				if (/^(\s*)([-*+]|\d+\.)\s+/.test(next)) break;
				if (/^\s{2,}/.test(next)) {
					itemLines.push(next.replace(/^\s{2,}/, ""));
					i += 1;
					continue;
				}
				break;
			}
			let li = doc.createElementNS(this.HTML_NS, "li");
			for (let child of this.buildMarkdownNodes(doc, itemLines.join("\n"), formulas)) {
				li.appendChild(child);
			}
			if (!li.childNodes.length) {
				this.appendInlineMarkdownNodes(doc, li, match[3], formulas);
			}
			list.appendChild(li);
			while (i < lines.length && !String(lines[i] || "").trim()) {
				i += 1;
			}
		}
		return { node: list, nextIndex: i };
	},

	appendInlineMarkdownNodes(doc, parent, text, formulas = []) {
		let parts = String(text || "").split("\n");
		parts.forEach((part, index) => {
			for (let node of this.buildInlineMarkdownNodes(doc, part, formulas)) {
				parent.appendChild(node);
			}
			if (index < parts.length - 1) {
				parent.appendChild(doc.createElementNS(this.HTML_NS, "br"));
			}
		});
	},

	buildInlineMarkdownNodes(doc, text, formulas = []) {
		let source = String(text || "");
		let nodes = [];
		let i = 0;
		let pushText = (value) => {
			if (!value) return;
			nodes.push(doc.createTextNode(value));
		};
		while (i < source.length) {
			let token =
				this.matchInlineToken(source, i, "`", "`", "code") ||
				this.matchInlineToken(source, i, "**", "**", "strong") ||
				this.matchInlineToken(source, i, "__", "__", "strong") ||
				this.matchInlineToken(source, i, "~~", "~~", "del") ||
				this.matchInlineToken(source, i, "*", "*", "em") ||
				this.matchInlineToken(source, i, "_", "_", "em") ||
				this.matchInlineLink(source, i) ||
				this.matchInlineFormulaPlaceholder(source, i, formulas) ||
				this.matchInlineParenFormula(source, i) ||
				this.matchInlineDollarFormula(source, i);
			if (!token) {
				pushText(source[i]);
				i += 1;
				continue;
			}
			if (token.start > i) {
				pushText(source.slice(i, token.start));
			}
			nodes.push(this.buildInlineTokenNode(doc, token, formulas));
			i = token.end;
		}
		return this.mergeAdjacentTextNodes(doc, nodes);
	},

	matchInlineFormulaPlaceholder(source, startIndex, formulas = []) {
		let rest = source.slice(startIndex);
		let match = rest.match(/^@@MATHINLINE(\d+)@@/);
		if (!match) return null;
		let formula = formulas[parseInt(match[1], 10)];
		if (!formula) return null;
		return {
			kind: "formula",
			start: startIndex,
			end: startIndex + match[0].length,
			content: formula.expr,
			openDelimiter: formula.openDelimiter,
			closeDelimiter: formula.closeDelimiter
		};
	},

	tokenizeFormulaPlaceholders(text) {
		let formulas = [];
		let push = (expr, openDelimiter, closeDelimiter, displayMode) => {
			let index = formulas.push({
				expr: String(expr || ""),
				openDelimiter,
				closeDelimiter,
				displayMode: !!displayMode
			}) - 1;
			return displayMode ? `@@MATHBLOCK${index}@@` : `@@MATHINLINE${index}@@`;
		};
		let protectedCode = this.protectMarkdownCodeSegments(String(text || ""));
		let out = protectedCode.text;
		out = out.replace(/^\s*\$\$([\s\S]+?)\$\$\s*$/gm, (_m, expr) => push(expr, "$$", "$$", true));
		out = out.replace(/^\s*\\\[([\s\S]+?)\\\]\s*$/gm, (_m, expr) => push(expr, "\\[", "\\]", true));
		out = out.replace(/\\\((.+?)\\\)/g, (_m, expr) => push(expr, "\\(", "\\)", false));
		out = this.replaceInlineDollarMath(out, (expr) => push(expr, "$", "$", false));
		out = this.restoreMarkdownCodeSegments(out, protectedCode.segments);
		return { text: out, formulas };
	},

	protectMarkdownCodeSegments(text) {
		let segments = [];
		let pushSegment = (value) => `\u0000CODETOKEN${segments.push(String(value || "")) - 1}\u0000`;
		let out = String(text || "");
		out = out.replace(/(^|\n)(```[^\n]*\n[\s\S]*?\n```)(?=\n|$)/g, (_match, prefix, block) => `${prefix}${pushSegment(block)}`);
		out = out.replace(/`[^`\n]*`/g, (segment) => pushSegment(segment));
		return { text: out, segments };
	},

	restoreMarkdownCodeSegments(text, segments = []) {
		return String(text || "").replace(/\u0000CODETOKEN(\d+)\u0000/g, (_match, index) => segments[parseInt(index, 10)] || "");
	},

	postProcessFormulaNodes(doc, nodes) {
		for (let node of nodes || []) {
			this.postProcessFormulaNode(doc, node);
		}
	},

	postProcessFormulaNode(doc, node) {
		if (!node || node.nodeType !== 1) return;
		if (node.getAttribute?.("data-md-formula")) return;
		let tag = String(node.localName || node.nodeName || "").toLowerCase();
		if (["pre", "code"].includes(tag)) return;
		if (["p", "div", "li", "blockquote"].includes(tag)) {
			let text = String(node.textContent || "").trim();
			let blockMatch = text.match(/^\$\$([\s\S]+)\$\$$/) || text.match(/^\\\[([\s\S]+)\\\]$/);
			if (blockMatch && node.childNodes.length === 1 && node.firstChild?.nodeType === 3) {
				let openDelimiter = text.startsWith("\\[") ? "\\[" : "$$";
				let closeDelimiter = text.startsWith("\\[") ? "\\]" : "$$";
				let formulaNode = this.buildFormulaNode(doc, blockMatch[1], true, openDelimiter, closeDelimiter);
				while (node.firstChild) node.removeChild(node.firstChild);
				node.appendChild(formulaNode);
				return;
			}
		}
		let children = Array.from(node.childNodes || []);
		for (let child of children) {
			if (child.nodeType === 3) {
				let replacements = this.buildTextFormulaSequence(doc, child.nodeValue || "");
				if (replacements.length === 1 && replacements[0].nodeType === 3) continue;
				for (let replacement of replacements) {
					node.insertBefore(replacement, child);
				}
				node.removeChild(child);
				continue;
			}
			this.postProcessFormulaNode(doc, child);
		}
	},

	buildTextFormulaSequence(doc, text) {
		let source = String(text || "");
		let nodes = [];
		let index = 0;
		let pushText = (value) => {
			if (!value) return;
			nodes.push(doc.createTextNode(value));
		};
		while (index < source.length) {
			let token =
				this.matchInlineParenFormula(source, index) ||
				this.matchInlineDollarFormula(source, index);
			if (!token) {
				pushText(source[index]);
				index += 1;
				continue;
			}
			if (token.start > index) {
				pushText(source.slice(index, token.start));
			}
			nodes.push(this.buildFormulaNode(doc, token.content, false, token.openDelimiter, token.closeDelimiter));
			index = token.end;
		}
		return this.mergeAdjacentTextNodes(doc, nodes);
	},

	matchInlineToken(source, startIndex, open, close, kind) {
		if (!source.startsWith(open, startIndex)) return null;
		let end = source.indexOf(close, startIndex + open.length);
		if (end <= startIndex + open.length) return null;
		return {
			kind,
			start: startIndex,
			end: end + close.length,
			content: source.slice(startIndex + open.length, end)
		};
	},

	matchInlineLink(source, startIndex) {
		if (source[startIndex] !== "[") return null;
		let mid = source.indexOf("](", startIndex + 1);
		if (mid === -1) return null;
		let end = source.indexOf(")", mid + 2);
		if (end === -1) return null;
		return {
			kind: "link",
			start: startIndex,
			end: end + 1,
			label: source.slice(startIndex + 1, mid),
			href: source.slice(mid + 2, end)
		};
	},

	matchInlineParenFormula(source, startIndex) {
		if (!source.startsWith("\\(", startIndex)) return null;
		let end = source.indexOf("\\)", startIndex + 2);
		if (end === -1) return null;
		return {
			kind: "formula",
			start: startIndex,
			end: end + 2,
			content: source.slice(startIndex + 2, end),
			openDelimiter: "\\(",
			closeDelimiter: "\\)"
		};
	},

	matchInlineDollarFormula(source, startIndex) {
		if (source[startIndex] !== "$" || source[startIndex + 1] === "$") return null;
		for (let i = startIndex + 1; i < source.length; i++) {
			if (source[i] === "\\" && i + 1 < source.length) {
				i += 1;
				continue;
			}
			if (source[i] === "$" && source[i - 1] !== "\\") {
				let content = source.slice(startIndex + 1, i);
				if (!content.trim() || content.includes("\n")) return null;
				return {
					kind: "formula",
					start: startIndex,
					end: i + 1,
					content,
					openDelimiter: "$",
					closeDelimiter: "$"
				};
			}
		}
		return null;
	},

	buildInlineTokenNode(doc, token, formulas = []) {
		switch (token.kind) {
			case "code": {
				let code = doc.createElementNS(this.HTML_NS, "code");
				code.textContent = token.content || "";
				return code;
			}
			case "strong":
			case "em":
			case "del": {
				let tag = token.kind === "strong" ? "strong" : (token.kind === "em" ? "em" : "del");
				let el = doc.createElementNS(this.HTML_NS, tag);
				for (let child of this.buildInlineMarkdownNodes(doc, token.content || "", formulas)) {
					el.appendChild(child);
				}
				return el;
			}
			case "link": {
				let a = doc.createElementNS(this.HTML_NS, "a");
				let href = this.sanitizeURL(token.href || "");
				if (href) a.setAttribute("href", href);
				for (let child of this.buildInlineMarkdownNodes(doc, token.label || token.href || "", formulas)) {
					a.appendChild(child);
				}
				return a;
			}
			case "formula":
				return this.buildFormulaNode(doc, token.content, false, token.openDelimiter, token.closeDelimiter);
			default:
				return doc.createTextNode(token.content || "");
		}
	},

	buildFormulaNode(doc, expr, displayMode, openDelimiter, closeDelimiter) {
		let safeExpr = this.sanitizeDOMString(expr);
		let raw = `${openDelimiter}${safeExpr}${closeDelimiter}`;
		let trimmedExpr = String(safeExpr || "").trim();
		let katex = this.getKatexRenderer(doc);
		let fallbackReason = katex ? "render-empty" : "katex-missing";
		if (trimmedExpr && katex) {
			try {
				let renderedNode = this.buildRenderedFormulaNode(doc, trimmedExpr, displayMode, raw, openDelimiter, closeDelimiter, katex);
				if (renderedNode) return renderedNode;
			}
			catch (e) {
				fallbackReason = `katex-error:${e?.message || e}`;
				Zotero.logError?.(e);
			}
		}
		return this.createFormulaFallbackNode(doc, raw, displayMode, fallbackReason);
	},

	buildRenderedFormulaNode(doc, expr, displayMode, raw, openDelimiter, closeDelimiter, katex) {
		if (katex?.renderToString) {
			let html = this.renderFormulaHTML(expr, displayMode, openDelimiter, closeDelimiter, katex);
			let parsed = this.parseHTMLToNodes(doc, html);
			let node = parsed[0] || null;
			return this.annotateFormulaTree(node, raw, displayMode);
		}
		if (katex?.render) {
			let host = doc.createElementNS(this.HTML_NS, displayMode ? "div" : "span");
			host.setAttribute("class", displayMode ? "zc-formula zc-formula-block" : "zc-formula zc-formula-inline");
			host.setAttribute("data-md-formula", raw);
			host.setAttribute("data-md-formula-display", displayMode ? "block" : "inline");
			host.setAttribute("data-md-formula-status", "katex-rendered");
			katex.render(expr, host, {
				displayMode: !!displayMode,
				throwOnError: false,
				output: "htmlAndMathml",
				trust: false,
				strict: "ignore"
			});
			return this.annotateFormulaTree(host, raw, displayMode);
		}
		return null;
	},

	createFormulaFallbackNode(doc, raw, displayMode, fallbackReason = "katex-missing") {
		this.log(`Formula fallback [${displayMode ? "block" : "inline"}]: ${fallbackReason}`);
		let fallback = doc.createElementNS(this.HTML_NS, displayMode ? "div" : "span");
		fallback.setAttribute("class", displayMode ? "zc-formula zc-formula-block zc-formula-fallback" : "zc-formula zc-formula-inline zc-formula-fallback");
		fallback.setAttribute("data-md-formula", raw);
		fallback.setAttribute("data-md-formula-display", displayMode ? "block" : "inline");
		fallback.setAttribute("data-md-formula-status", fallbackReason);
		fallback.setAttribute("title", `Formula fallback: ${fallbackReason}`);
		fallback.textContent = raw;
		return fallback;
	},

	annotateFormulaTree(node, raw, displayMode) {
		if (!node || node.nodeType !== 1) return node;
		let formula = String(raw || "").trim();
		if (!formula) return node;
		let mode = displayMode ? "block" : "inline";
		for (let el of [node, ...Array.from(node.querySelectorAll?.("*") || [])]) {
			el.setAttribute?.("data-md-formula", formula);
			el.setAttribute?.("data-md-formula-display", mode);
		}
		return node;
	},

	mergeAdjacentTextNodes(doc, nodes) {
		let merged = [];
		for (let node of nodes || []) {
			if (!node) continue;
			let last = merged[merged.length - 1];
			if (last?.nodeType === 3 && node.nodeType === 3) {
				last.nodeValue += node.nodeValue || "";
			}
			else {
				merged.push(node.nodeType === 3 ? doc.createTextNode(node.nodeValue || "") : node);
			}
		}
		return merged;
	},

	renderMarkdownHTML(markdownText) {
		let text = this.sanitizeDOMString(markdownText).replace(/\r\n?/g, "\n");
		let tokens = [];
		let pushToken = (html) => `\u0000MDTOKEN${tokens.push(html) - 1}\u0000`;
		text = text.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
			let safeLang = String(lang || "").trim();
			let safeCode = String(code || "").replace(/\n$/, "");
			let langAttr = safeLang ? ` data-language="${this.escapeHTML(safeLang)}"` : "";
			return pushToken(`<pre><code${langAttr}>${this.escapeHTML(safeCode)}</code></pre>`);
		});
		text = text.replace(/^\$\$([\s\S]+?)\$\$$/gm, (_match, expr) => pushToken(this.renderFormulaHTML(expr, true, "$$", "$$")));
		text = text.replace(/^\\\[([\s\S]+?)\\\]$/gm, (_match, expr) => pushToken(this.renderFormulaHTML(expr, true, "\\[", "\\]")));
		text = this.renderInlineMarkdown(text, tokens);
		let marked = this.getMarkedRenderer();
		let html = marked?.parse ? marked.parse(text, {
			async: false,
			breaks: true,
			gfm: true
		}) : text.replace(/\n/g, "<br>");
		return this.restoreMarkdownTokens(String(html || ""), tokens);
	},

	renderInlineMarkdown(text, tokens = []) {
		let pushToken = (html) => `\u0000MDTOKEN${tokens.push(html) - 1}\u0000`;
		let raw = String(text || "");
		raw = raw.replace(/\\\((.+?)\\\)/g, (_match, expr) => pushToken(this.renderFormulaHTML(expr, false, "\\(", "\\)")));
		raw = this.replaceInlineDollarMath(raw, (expr) => pushToken(this.renderFormulaHTML(expr, false, "$", "$")));
		return raw;
	},

	restoreMarkdownTokens(text, tokens = []) {
		return String(text || "").replace(/\u0000MDTOKEN(\d+)\u0000/g, (_match, index) => tokens[parseInt(index, 10)] || "");
	},

	replaceInlineDollarMath(text, render) {
		let source = String(text || "");
		let result = "";
		for (let i = 0; i < source.length; i++) {
			let char = source[i];
			if (char === "\\" && i + 1 < source.length) {
				result += source.slice(i, i + 2);
				i += 1;
				continue;
			}
			if (char !== "$" || source[i + 1] === "$") {
				result += char;
				continue;
			}
			let end = -1;
			for (let j = i + 1; j < source.length; j++) {
				if (source[j] === "\\" && j + 1 < source.length) {
					j += 1;
					continue;
				}
				if (source[j] === "$" && source[j - 1] !== "\\" && source[j + 1] !== "$") {
					end = j;
					break;
				}
			}
			if (end > i + 1) {
				let expr = source.slice(i + 1, end);
				if (expr.trim() && !expr.includes("\n")) {
					result += render(expr);
					i = end;
					continue;
				}
			}
			result += char;
		}
		return result;
	},

	resolveKatexRuntime(...scopes) {
		let candidates = [
			globalThis.ZoteroCopilotKaTeX,
			globalThis.katex
		];
		for (let scope of scopes) {
			candidates.push(
				scope,
				scope?.default,
				scope?.katex,
				scope?.default?.katex,
				scope?.module?.exports,
				scope?.module?.exports?.default,
				scope?.module?.exports?.katex,
				scope?.exports,
				scope?.exports?.default,
				scope?.exports?.katex
			);
		}
		for (let candidate of candidates) {
			if (candidate?.renderToString || candidate?.render) {
				return candidate;
			}
		}
		return null;
	},

	getContextWindow(context) {
		if (!context) return null;
		if (context.window === context) return context;
		return context.defaultView || context.ownerGlobal || context.ownerDocument?.defaultView || null;
	},

	ensureKatexRuntime(context = null) {
		let win = this.getContextWindow(context);
		let existing = this.resolveKatexRuntime(
			globalThis.ZoteroCopilotKaTeX,
			globalThis.katex,
			win?.ZoteroCopilotKaTeX,
			win?.katex,
			win
		);
		if (existing) {
			if (win) {
				win.ZoteroCopilotKaTeX = existing;
			}
			globalThis.ZoteroCopilotKaTeX = existing;
			return existing;
		}
		try {
			if (this.rootURI && typeof Services !== "undefined" && Services.scriptloader?.loadSubScript) {
				if (win) {
					Services.scriptloader.loadSubScript(this.rootURI + "vendor/katex/katex.min.js", win);
					let loadedInWindow = this.resolveKatexRuntime(win);
					if (loadedInWindow) {
						win.ZoteroCopilotKaTeX = loadedInWindow;
						globalThis.ZoteroCopilotKaTeX = loadedInWindow;
						return loadedInWindow;
					}
				}
				let scope = {
					module: { exports: {} },
					exports: {}
				};
				Services.scriptloader.loadSubScript(this.rootURI + "vendor/katex/katex.min.js", scope);
				let loaded = this.resolveKatexRuntime(scope);
				if (loaded) {
					globalThis.ZoteroCopilotKaTeX = loaded;
					return loaded;
				}
			}
		}
		catch (_e) {}
		return null;
	},

	getKatexRenderer(context = null) {
		let katex = this.ensureKatexRuntime(context);
		return katex?.renderToString || katex?.render ? katex : null;
	},

	getMarkedRenderer() {
		return globalThis.ZoteroCopilotMarked?.parse ? globalThis.ZoteroCopilotMarked : (globalThis.ZoteroCopilotMarked?.marked || globalThis.marked || null);
	},

	renderFormulaHTML(expr, displayMode, openDelimiter, closeDelimiter, katexOverride = null) {
		let safeExpr = this.sanitizeDOMString(expr);
		let source = `${openDelimiter}${safeExpr}${closeDelimiter}`;
		let dataAttr = this.escapeHTML(source);
		let katex = katexOverride || this.getKatexRenderer();
		try {
			if (katex?.renderToString) {
				let rendered = katex.renderToString(String(safeExpr || "").trim(), {
					displayMode: !!displayMode,
					throwOnError: false,
					output: "htmlAndMathml",
					trust: false,
					strict: "ignore"
				});
				let className = displayMode ? "zc-formula zc-formula-block" : "zc-formula zc-formula-inline";
				let tag = displayMode ? "div" : "span";
				return `<${tag} class="${className}" data-md-formula="${dataAttr}" data-md-formula-status="katex-rendered">${rendered}</${tag}>`;
			}
		}
		catch (_e) {}
		let fallbackClass = displayMode ? "zc-formula zc-formula-block zc-formula-fallback" : "zc-formula zc-formula-inline zc-formula-fallback";
		let tag = displayMode ? "div" : "span";
		return `<${tag} class="${fallbackClass}" data-md-formula="${dataAttr}" data-md-formula-status="katex-missing">${this.escapeHTML(source)}</${tag}>`;
	},

	sanitizeURL(url) {
		let raw = String(url || "").trim();
		if (!raw) return "";
		if (!/^(https?:|mailto:|#|\/)/i.test(raw)) return "";
		return this.escapeHTML(raw);
	},

	escapeHTML(text) {
		return this.sanitizeDOMString(text)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");
	},

	serializeFragmentToMarkdown(fragment) {
		return this.normalizeCopiedMarkdown(Array.from(fragment.childNodes || []).map((node) => this.serializeMarkdownNode(node)).join(""));
	},

	isBlockFormulaSource(source) {
		let raw = String(source || "").trim();
		return /^\$\$[\s\S]*\$\$$/.test(raw) || /^\\\[[\s\S]*\\\]$/.test(raw);
	},

	formatCopiedFormula(source, displayMode = false) {
		let raw = String(source || "").trim();
		if (!raw) return "";
		return displayMode ? `\n\n${raw}\n\n` : raw;
	},

	getSerializedFormulaSource(node) {
		if (!node || node.nodeType !== 1) return "";
		let rawFormula = node.getAttribute?.("data-md-formula");
		if (rawFormula) {
			let displayMode = String(node.getAttribute?.("data-md-formula-display") || "").toLowerCase() === "block" || this.isBlockFormulaSource(rawFormula);
			return this.formatCopiedFormula(rawFormula, displayMode);
		}
		let tag = String(node.nodeName || "").toLowerCase();
		if (tag === "annotation" && String(node.getAttribute?.("encoding") || "").toLowerCase() === "application/x-tex") {
			let expr = this.sanitizeDOMString(node.textContent || "").trim();
			if (!expr) return "";
			let displayMode = String(node.getAttribute?.("data-md-formula-display") || "").toLowerCase() === "block" || !!node.closest?.(".zc-formula-block, .katex-display");
			return this.formatCopiedFormula(`${displayMode ? "$$" : "$"}${expr}${displayMode ? "$$" : "$"}`, displayMode);
		}
		if (node.classList?.contains("katex") || node.classList?.contains("katex-display") || node.classList?.contains("katex-mathml") || tag === "math") {
			let annotation = node.querySelector?.('annotation[encoding="application/x-tex"]');
			let expr = this.sanitizeDOMString(annotation?.textContent || "").trim();
			if (!expr) return "";
			let displayMode = String(node.getAttribute?.("data-md-formula-display") || "").toLowerCase() === "block" || node.classList?.contains("katex-display") || !!node.closest?.(".zc-formula-block, .katex-display");
			return this.formatCopiedFormula(`${displayMode ? "$$" : "$"}${expr}${displayMode ? "$$" : "$"}`, displayMode);
		}
		return "";
	},

	serializeMarkdownNode(node, context = {}) {
		if (!node) return "";
		if (node.nodeType === 3) {
			return node.textContent || "";
		}
		if (node.nodeType !== 1 && node.nodeType !== 11) {
			return "";
		}
		if (node.nodeType === 11) {
			return Array.from(node.childNodes || []).map((child) => this.serializeMarkdownNode(child, context)).join("");
		}
		let serializedFormula = this.getSerializedFormulaSource(node);
		if (serializedFormula) {
			return serializedFormula;
		}
		let tag = String(node.nodeName || "").toLowerCase();
		let children = Array.from(node.childNodes || []).map((child) => this.serializeMarkdownNode(child, context)).join("");
		switch (tag) {
			case "br":
				return "\n";
			case "strong":
			case "b":
				return `**${children}**`;
			case "em":
			case "i":
				return `*${children}*`;
			case "del":
			case "s":
				return `~~${children}~~`;
			case "code":
				if (String(node.parentNode?.nodeName || "").toLowerCase() === "pre") {
					return node.textContent || "";
				}
				return `\`${children}\``;
			case "pre":
				return `\n\`\`\`\n${(node.textContent || "").replace(/\n+$/, "")}\n\`\`\`\n\n`;
			case "a": {
				let href = node.getAttribute?.("href") || "";
				let label = children || href;
				return href ? `[${label}](${href})` : label;
			}
			case "p":
				return `${children}\n\n`;
			case "h1":
			case "h2":
			case "h3":
			case "h4":
			case "h5":
			case "h6":
				return `${"#".repeat(parseInt(tag.slice(1), 10))} ${children}\n\n`;
			case "blockquote": {
				let quote = this.normalizeCopiedMarkdown(children).split("\n").map((line) => line ? `> ${line}` : ">").join("\n");
				return `${quote}\n\n`;
			}
			case "ul":
				return `${Array.from(node.children || []).map((child) => `- ${this.normalizeCopiedMarkdown(this.serializeMarkdownNode(child)).replace(/\n/g, "\n  ")}`).join("\n")}\n\n`;
			case "ol":
				return `${Array.from(node.children || []).map((child, index) => `${index + 1}. ${this.normalizeCopiedMarkdown(this.serializeMarkdownNode(child)).replace(/\n/g, "\n   ")}`).join("\n")}\n\n`;
			case "li":
				return this.normalizeCopiedMarkdown(children);
			case "summary":
				return "";
			default:
				return children;
		}
	},

	normalizeCopiedMarkdown(text) {
		return String(text || "")
			.replace(/\r\n?/g, "\n")
			.replace(/[ \t]+\n/g, "\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
	},

	sanitizeDOMString(text) {
		let source = String(text || "");
		let out = "";
		for (let i = 0; i < source.length; i++) {
			let code = source.charCodeAt(i);
			if (code >= 0xD800 && code <= 0xDBFF) {
				let next = source.charCodeAt(i + 1);
				if (next >= 0xDC00 && next <= 0xDFFF) {
					out += source[i] + source[i + 1];
					i += 1;
				}
				continue;
			}
			if (code >= 0xDC00 && code <= 0xDFFF) continue;
			if ((code >= 0 && code < 0x20 && ![0x09, 0x0A, 0x0D].includes(code)) || code === 0xFFFE || code === 0xFFFF) {
				continue;
			}
			out += source[i];
		}
		return out;
	},

	normalizeHTMLForXHTML(html) {
		return String(html || "")
			.replace(/<br(?=[\s>])(?![^>]*\/>)/gi, "<br />")
			.replace(/<hr(?=[\s>])(?![^>]*\/>)/gi, "<hr />")
			.replace(/<img([^>]*?)(?<!\/)>/gi, "<img$1 />")
			.replace(/<input([^>]*?)(?<!\/)>/gi, "<input$1 />");
	},

	parseHTMLToNodes(doc, html) {
		let source = String(html || "");
		let DOMParserCtor = doc.defaultView?.DOMParser || globalThis.DOMParser;
		if (!DOMParserCtor) {
			throw new Error("DOMParser unavailable");
		}
		let parser = new DOMParserCtor();
		let wrappedHTML = `<body>${source}</body>`;
		let parsed = parser.parseFromString(wrappedHTML, "text/html");
		let body = parsed?.body;
		if (!body) {
			throw new Error("Failed to parse markdown HTML");
		}
		let nodes = [];
		for (let child of Array.from(body.childNodes || [])) {
			let converted = this.cloneHTMLNodeIntoDocument(doc, child);
			if (converted) nodes.push(converted);
		}
		return nodes;
	},

	cloneHTMLNodeIntoDocument(doc, node) {
		if (!node) return null;
		switch (node.nodeType) {
			case node.TEXT_NODE:
				return doc.createTextNode(node.nodeValue || "");
			case node.ELEMENT_NODE: {
				let tag = String(node.localName || node.nodeName || "").toLowerCase();
				if (!tag) return null;
				let ns = this.getNodeNamespace(node);
				let el = doc.createElementNS(ns, tag);
				for (let attrName of node.getAttributeNames?.() || []) {
					let attrNS = node.getAttributeNode(attrName)?.namespaceURI || null;
					if (attrNS) {
						el.setAttributeNS(attrNS, attrName, node.getAttribute(attrName));
					}
					else {
						el.setAttribute(attrName, node.getAttribute(attrName));
					}
				}
				for (let child of Array.from(node.childNodes || [])) {
					let clonedChild = this.cloneHTMLNodeIntoDocument(doc, child);
					if (clonedChild) el.appendChild(clonedChild);
				}
				return el;
			}
			default:
				return null;
		}
	},

	getNodeNamespace(node) {
		let ns = node?.namespaceURI || "";
		if (ns === this.MATHML_NS || ns === this.SVG_NS || ns === this.HTML_NS) {
			return ns;
		}
		let tag = String(node?.localName || node?.nodeName || "").toLowerCase();
		if (["math", "semantics", "mrow", "mi", "mn", "mo", "msup", "msub", "msubsup", "mfrac", "msqrt", "mroot", "mtext", "mspace", "mtable", "mtr", "mtd", "mstyle", "annotation", "annotation-xml"].includes(tag)) {
			return this.MATHML_NS;
		}
		if (["svg", "path", "g", "line", "rect", "circle", "ellipse", "polyline", "polygon", "text", "defs", "clippath"].includes(tag)) {
			return this.SVG_NS;
		}
		return this.HTML_NS;
	},

	getViewCSS() {
		return `
			#zotero-copilot-panel {
				min-width: 340px;
				width: 420px;
				max-width: 840px;
				overflow: hidden;
				border-left: 1px solid rgba(127, 127, 127, 0.28);
				background: var(--material-sidepane, #f6f6f6);
				position: relative;
				z-index: auto;
			}
			#zotero-copilot-splitter {
				border-left: 1px solid rgba(127,127,127,0.14);
				border-right: 1px solid rgba(127,127,127,0.14);
				background: rgba(127,127,127,0.06);
			}
			.zotero-copilot-toolbar-button {
				display: inline-flex;
				align-items: center;
			}
			toolbarseparator.zotero-copilot-toolbar-separator,
			.zotero-copilot-toolbar-separator {
				display:inline-block;
				width:1px;
				height:16px;
				margin:0 6px;
				background:rgba(127,127,127,0.28);
				vertical-align:middle;
			}
			.zotero-copilot-toolbar-button.is-checked {
				opacity: 1;
			}
			.zc-toolbar-icon {
				width: 16px;
				height: 16px;
				display: inline-block;
				vertical-align: middle;
			}
			.zc-pane-root {
				--zc-bg-1: #f6f6f6;
				--zc-bg-2: #efefef;
				--zc-accent-glow: rgba(0,0,0,0);
				--zc-text: #222426;
				--zc-subtle: #5f6873;
				--zc-muted: #6d7680;
				--zc-border: rgba(127,127,127,0.34);
				--zc-soft-border: rgba(127,127,127,0.20);
				--zc-surface: rgba(255,255,255,0.72);
				--zc-surface-strong: #ffffff;
				--zc-drop: rgba(255,255,255,0.62);
				--zc-chip: rgba(64,101,161,0.10);
				--zc-user: rgba(64,101,161,0.12);
				--zc-user-border: rgba(64,101,161,0.20);
				--zc-assistant: rgba(127,127,127,0.08);
				--zc-assistant-border: rgba(127,127,127,0.16);
				--zc-error: rgba(196,64,64,0.10);
				--zc-error-border: rgba(196,64,64,0.18);
				--zc-shadow: none;
				display:flex;
				flex-direction:column;
				height:100%;
				min-height:0;
				padding:8px;
				box-sizing:border-box;
				background: linear-gradient(180deg, var(--zc-bg-1) 0%, var(--zc-bg-2) 100%);
				color:var(--zc-text);
				font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
			}
			:root[lwtheme-brighttext] .zc-pane-root,
			:root[brighttext] .zc-pane-root {
				--zc-bg-1: #2b2d30;
				--zc-bg-2: #25272a;
				--zc-accent-glow: rgba(0,0,0,0);
				--zc-text: #e7e9ec;
				--zc-subtle: #a7b0bb;
				--zc-muted: #8e98a4;
				--zc-border: rgba(255,255,255,0.14);
				--zc-soft-border: rgba(255,255,255,0.10);
				--zc-surface: rgba(255,255,255,0.04);
				--zc-surface-strong: rgba(255,255,255,0.06);
				--zc-drop: rgba(255,255,255,0.03);
				--zc-chip: rgba(110,168,255,0.14);
				--zc-user: rgba(110,168,255,0.14);
				--zc-user-border: rgba(110,168,255,0.22);
				--zc-assistant: rgba(255,255,255,0.04);
				--zc-assistant-border: rgba(255,255,255,0.10);
				--zc-error: rgba(255,107,107,0.12);
				--zc-error-border: rgba(255,107,107,0.20);
				--zc-shadow: none;
			}
			@media (prefers-color-scheme: dark) {
				.zc-pane-root {
					--zc-bg-1: #2b2d30;
					--zc-bg-2: #25272a;
					--zc-accent-glow: rgba(0,0,0,0);
					--zc-text: #e7e9ec;
					--zc-subtle: #a7b0bb;
					--zc-muted: #8e98a4;
					--zc-border: rgba(255,255,255,0.14);
					--zc-soft-border: rgba(255,255,255,0.10);
					--zc-surface: rgba(255,255,255,0.04);
					--zc-surface-strong: rgba(255,255,255,0.06);
					--zc-drop: rgba(255,255,255,0.03);
					--zc-chip: rgba(110,168,255,0.14);
					--zc-user: rgba(110,168,255,0.14);
					--zc-user-border: rgba(110,168,255,0.22);
					--zc-assistant: rgba(255,255,255,0.04);
					--zc-assistant-border: rgba(255,255,255,0.10);
					--zc-error: rgba(255,107,107,0.12);
					--zc-error-border: rgba(255,107,107,0.20);
					--zc-shadow: none;
				}
			}
			.zc-pane-header, .zc-pane-actions, .zc-pane-session-row, .zc-composer-profile-row, .zc-composer-footer, .zc-composer-submit, .zc-composer-secondary-actions, .zc-message-top, .zc-message-actions, .zc-input-wrap { display:flex; align-items:center; gap:8px; }
			.zc-pane-header, .zc-status, .zc-composer { margin-bottom:8px; }
			.zc-pane-header { flex-direction:column; align-items:stretch; gap:8px; }
			.zc-pane-session-row, .zc-pane-actions, .zc-composer-footer, .zc-pane-actions-group { align-items: center; }
			.zc-pane-session-row { width:100%; min-width:0; }
			.zc-pane-actions { width:100%; justify-content:space-between; flex-wrap:wrap; }
			.zc-pane-actions-group { display:flex; gap:8px; flex-wrap:wrap; }
			.zc-pane-subtitle, .zc-helper { display:none; }
			.zc-btn { border:1px solid var(--zc-border); border-radius:6px; padding:5px 10px; cursor:pointer; background:var(--zc-surface); color:var(--zc-text); font:600 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; transition:background 140ms ease, border-color 140ms ease, color 140ms ease, box-shadow 140ms ease, transform 100ms ease; }
			.zc-btn:hover { background:color-mix(in srgb, var(--zc-surface-strong) 88%, rgba(64,101,161,0.10)); border-color:color-mix(in srgb, var(--zc-user-border) 78%, var(--zc-border)); box-shadow:0 0 0 1px color-mix(in srgb, var(--zc-user-border) 34%, transparent), 0 3px 10px rgba(0,0,0,0.08); }
			.zc-btn:active { transform:translateY(1px) scale(0.98); background:color-mix(in srgb, var(--zc-surface) 84%, rgba(64,101,161,0.16)); box-shadow:inset 0 1px 2px rgba(0,0,0,0.12); }
			.zc-btn:focus-visible { outline:none; border-color:var(--zc-user-border); box-shadow:0 0 0 2px color-mix(in srgb, var(--zc-user-border) 42%, transparent), 0 3px 10px rgba(0,0,0,0.08); }
			.zc-btn-primary { background: rgba(64,101,161,0.12); color: var(--zc-text); border-color: rgba(64,101,161,0.28); }
			.zc-btn-primary:hover { background:rgba(64,101,161,0.20); border-color:rgba(64,101,161,0.40); box-shadow:0 0 0 1px rgba(64,101,161,0.16), 0 4px 12px rgba(64,101,161,0.14); }
			.zc-btn-primary:active { background:rgba(64,101,161,0.24); box-shadow:inset 0 1px 2px rgba(0,0,0,0.14); }
			.zc-btn-danger { border-color: rgba(179,81,81,0.35); color: #b35151; }
			.zc-btn-danger:hover { background: rgba(179,81,81,0.12); border-color: rgba(179,81,81,0.52); box-shadow:0 0 0 1px rgba(179,81,81,0.18), 0 3px 10px rgba(179,81,81,0.08); }
			.zc-btn-danger:active { background: rgba(179,81,81,0.16); box-shadow: inset 0 1px 2px rgba(0,0,0,0.12); }
			.zc-btn:disabled { opacity:0.6; cursor:not-allowed; }
			.zc-btn:disabled:hover, .zc-btn:disabled:active { transform:none; box-shadow:none; background:var(--zc-surface); border-color:var(--zc-border); }
			.zc-session-select { flex:1 1 auto; width:100%; min-width:0; min-height:28px; box-sizing:border-box; border:1px solid var(--zc-border); border-radius:14px; padding:2px 28px 2px 10px; background-color:var(--zc-surface); color:var(--zc-text); font:600 12px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; appearance:auto; -moz-appearance:menulist; background-image:none; }
			.zc-session-select:hover { border-color:var(--zc-user-border); background:var(--zc-surface-strong); }
			.zc-session-select:focus { outline:none; border-color:var(--zc-user-border); box-shadow: 0 0 0 1px color-mix(in srgb, var(--zc-user-border) 55%, transparent); }
			.zc-profile-controls, .zc-prompt-controls { display:flex; flex-direction:row; align-items:center; gap:8px; min-width:0; width:auto; max-width:100%; }
			.zc-prompt-controls { margin-left:auto; justify-content:flex-end; }
			.zc-profile-select, .zc-prompt-select { flex:0 1 180px; width:180px; max-width:180px; min-width:120px; min-height:28px; box-sizing:border-box; border:1px solid var(--zc-border); border-radius:14px; padding:2px 28px 2px 10px; background-color:var(--zc-surface); color:var(--zc-text); font:600 12px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; appearance:auto; -moz-appearance:menulist; background-image:none; }
			.zc-profile-select:hover, .zc-prompt-select:hover { border-color:var(--zc-user-border); background:var(--zc-surface-strong); }
			.zc-profile-select:focus, .zc-prompt-select:focus { outline:none; border-color:var(--zc-user-border); box-shadow: 0 0 0 1px color-mix(in srgb, var(--zc-user-border) 55%, transparent); }
			.zc-profile-settings-button { min-height:28px; width:28px; min-width:28px; padding:0; font-size:11px; flex:0 0 auto; position:relative; }
			.zc-profile-settings-button::before { content:""; display:block; width:14px; height:14px; margin:auto; background-color:currentColor; -webkit-mask-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='black' d='M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.14 7.14 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 2h-3.8a.5.5 0 0 0-.49.42l-.36 2.54c-.58.23-1.12.54-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 8.48a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.31.6.22l2.39-.96c.51.4 1.05.72 1.63.94l.36 2.54c.04.24.25.42.49.42h3.8c.24 0 .45-.18.49-.42l.36-2.54c.58-.23 1.12-.54 1.63-.94l2.39.96c.22.09.47 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z'/%3E%3C/svg%3E"); mask-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='black' d='M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.14 7.14 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 2h-3.8a.5.5 0 0 0-.49.42l-.36 2.54c-.58.23-1.12.54-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 8.48a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.31.6.22l2.39-.96c.51.4 1.05.72 1.63.94l.36 2.54c.04.24.25.42.49.42h3.8c.24 0 .45-.18.49-.42l.36-2.54c.58-.23 1.12-.54 1.63-.94l2.39.96c.22.09.47 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z'/%3E%3C/svg%3E"); -webkit-mask-repeat:no-repeat; mask-repeat:no-repeat; -webkit-mask-position:center; mask-position:center; -webkit-mask-size:14px 14px; mask-size:14px 14px; }
			.zc-input { width:100%; box-sizing:border-box; border:1px solid var(--zc-border); border-radius:6px; background:var(--zc-surface-strong); color:var(--zc-text); }
			.zc-source-list { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px; }
			.zc-composer-sources { min-height: 0; }
			.zc-chip { display:inline-flex; align-items:center; gap:6px; max-width:100%; padding:4px 8px; border-radius:999px; background:var(--zc-chip); border: 1px solid var(--zc-soft-border); font-size:12px; transition:background 120ms ease, border-color 120ms ease, transform 120ms ease, box-shadow 120ms ease; }
			.zc-source-jump { cursor:pointer; }
			.zc-source-jump:hover { background:color-mix(in srgb, var(--zc-chip) 62%, var(--zc-surface-strong)); border-color:var(--zc-user-border); box-shadow: 0 0 0 1px color-mix(in srgb, var(--zc-user-border) 50%, transparent), 0 3px 8px rgba(0,0,0,0.08); }
			.zc-source-jump:active { transform:translateY(1px) scale(0.985); background:color-mix(in srgb, var(--zc-chip) 78%, var(--zc-surface-strong)); box-shadow: inset 0 1px 2px rgba(0,0,0,0.12); }
			.zc-chip-label { max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
			.zc-chip-remove { display:inline-grid; place-items:center; width:16px; height:16px; min-width:16px; border:0; background:transparent; padding:0; margin-left:2px; font-size:11px; font-weight:700; line-height:1; cursor:pointer; color:var(--zc-subtle); border-radius:999px; transition:background 120ms ease, color 120ms ease, transform 120ms ease, box-shadow 120ms ease; }
			.zc-chip-remove:hover { background:color-mix(in srgb, var(--zc-surface-strong) 78%, rgba(64,101,161,0.12)); color:var(--zc-text); box-shadow: 0 0 0 1px color-mix(in srgb, var(--zc-user-border) 50%, transparent), 0 2px 6px rgba(0,0,0,0.08); }
			.zc-chip-remove:active { transform:translateY(1px) scale(0.9); background:color-mix(in srgb, var(--zc-surface) 82%, rgba(64,101,161,0.18)); box-shadow: inset 0 1px 2px rgba(0,0,0,0.12); }
			.zc-status { min-height:18px; font-size:12px; color:var(--zc-subtle); }
			.zc-status.is-error { color:#b91c1c; }
			.zc-messages-wrap { flex:1 1 auto; min-height:180px; position:relative; }
			.zc-empty-state, .zc-messages { height:100%; box-sizing:border-box; border-radius:8px; background:var(--zc-surface); border:1px solid var(--zc-soft-border); box-shadow:none; }
			.zc-empty-state { display:flex; align-items:center; justify-content:center; padding:18px; text-align:center; color:var(--zc-muted); }
			.zc-messages { display:none; overflow-y:auto; padding:8px; }
			.zc-messages.has-messages { display:flex; flex-direction:column; gap:10px; }
			.zc-message { display:flex; flex-direction:column; gap:6px; padding:8px 10px; border-radius:8px; max-width:95%; animation:zc-fade-in 140ms ease-out; transition:border-color 120ms ease, box-shadow 120ms ease, background 120ms ease; }
			.zc-message-top { justify-content:space-between; gap:12px; }
			.zc-message-user { align-self:flex-end; background:var(--zc-user); border:1px solid var(--zc-user-border); }
			.zc-message-assistant { align-self:flex-start; background:var(--zc-assistant); border:1px solid var(--zc-assistant-border); }
			.zc-message-error { align-self:flex-start; background:var(--zc-error); border:1px solid var(--zc-error-border); }
			.zc-message.is-editing { box-shadow: inset 0 0 0 1px rgba(64,101,161,0.24); border-color: rgba(64,101,161,0.46); background: color-mix(in srgb, var(--zc-user) 82%, var(--zc-surface-strong)); }
			.zc-message-role { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; }
			.zc-message-actions { margin-left:auto; gap:6px; justify-content:flex-end; opacity:1; pointer-events:auto; }
			.zc-message-action { display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; border:1px solid transparent; border-radius:999px; background:transparent; color:var(--zc-subtle); cursor:pointer; padding:0; font: 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; transition:background 120ms ease, border-color 120ms ease, color 120ms ease, transform 100ms ease, box-shadow 120ms ease; }
			.zc-message-action:hover { color:var(--zc-text); background:color-mix(in srgb, var(--zc-surface-strong) 82%, rgba(64,101,161,0.10)); border-color:color-mix(in srgb, var(--zc-user-border) 45%, var(--zc-soft-border)); box-shadow:0 0 0 1px color-mix(in srgb, var(--zc-user-border) 28%, transparent), 0 2px 6px rgba(0,0,0,0.08); }
			.zc-message-action:active { transform:translateY(1px) scale(0.93); background:color-mix(in srgb, var(--zc-surface) 78%, rgba(64,101,161,0.16)); box-shadow: inset 0 1px 2px rgba(0,0,0,0.12); }
			.zc-message-sources { display:flex; flex-wrap:wrap; gap:6px; }
			.zc-message-reasoning { border:1px solid var(--zc-soft-border); border-radius:6px; padding:6px 8px; background:var(--zc-surface); }
			.zc-message-reasoning-summary { cursor:pointer; color:var(--zc-subtle); }
			.zc-message-reasoning-body { margin-top:6px; color:var(--zc-subtle); font-size:12px; }
			.zc-message-body { }
			.zc-markdown { user-select:text; -moz-user-select:text; white-space:normal; }
			.zc-markdown-fallback { white-space:pre-wrap; }
			.zc-markdown p, .zc-markdown ul, .zc-markdown ol, .zc-markdown pre, .zc-markdown blockquote, .zc-markdown h1, .zc-markdown h2, .zc-markdown h3, .zc-markdown h4, .zc-markdown h5, .zc-markdown h6 { margin:0 0 8px; }
			.zc-markdown p:last-child, .zc-markdown ul:last-child, .zc-markdown ol:last-child, .zc-markdown pre:last-child, .zc-markdown blockquote:last-child { margin-bottom:0; }
			.zc-markdown h1, .zc-markdown h2, .zc-markdown h3, .zc-markdown h4, .zc-markdown h5, .zc-markdown h6 { line-height:1.3; font-weight:700; }
			.zc-markdown h1 { font-size:18px; }
			.zc-markdown h2 { font-size:16px; }
			.zc-markdown h3 { font-size:15px; }
			.zc-markdown ul, .zc-markdown ol { padding-left:18px; }
			.zc-markdown li + li { margin-top:4px; }
			.zc-markdown blockquote { padding-left:10px; border-left:3px solid var(--zc-soft-border); color:var(--zc-subtle); }
			.zc-markdown code { font-family:Consolas, "SFMono-Regular", monospace; font-size:12px; padding:1px 4px; border-radius:4px; background:var(--zc-surface); border:1px solid var(--zc-soft-border); }
			.zc-markdown pre { overflow:auto; padding:8px 10px; border-radius:8px; background:color-mix(in srgb, var(--zc-surface) 88%, #000 4%); border:1px solid var(--zc-soft-border); }
			.zc-markdown pre code { display:block; padding:0; border:0; background:transparent; }
			.zc-markdown a { color:inherit; text-decoration:underline; text-underline-offset:2px; }
			.zc-stream-tail { white-space:pre-wrap; }
			.zc-formula-inline { display:inline-block; vertical-align:middle; max-width:100%; padding:0 1px; }
			.zc-formula-block { display:block; overflow-x:auto; margin:8px 0; padding:8px 10px; border-radius:8px; background:color-mix(in srgb, var(--zc-surface) 88%, rgba(64,101,161,0.04)); border:1px solid var(--zc-soft-border); }
			.zc-formula-fallback { font-family:Consolas, "SFMono-Regular", monospace; white-space:pre-wrap; }
			.zc-composer { margin-top:0; }
			.zc-input-wrap { position:relative; align-items:flex-start; }
			.zc-context-button-wrap { position:relative; flex:0 0 auto; }
			.zc-context-button-wrap[hidden] { display:none; }
			.zc-context-button { width:28px; min-width:28px; min-height:28px; padding:0; border-radius:999px; display:inline-flex; align-items:center; justify-content:center; text-align:center; line-height:0; }
			.zc-context-button-glyph { display:block; width:14px; height:14px; color:currentColor; transform:translate(0.5px, -0.5px); pointer-events:none; }
			.zc-context-menu { position:absolute; left:0; bottom:calc(100% + 8px); min-width:220px; max-width:280px; padding:4px; border:1px solid var(--zc-soft-border); border-radius:10px; background:var(--zc-surface-strong); box-shadow:0 8px 18px rgba(0,0,0,0.12); z-index:30; }
			.zc-context-menu[hidden] { display:none; }
			.zc-context-menu-list { display:flex; flex-direction:column; gap:2px; }
			.zc-context-menu-item { display:flex; align-items:center; width:100%; padding:7px 10px; border:0; border-radius:8px; background:transparent; color:var(--zc-text); text-align:left; font:600 12px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; cursor:pointer; transition:background 120ms ease, color 120ms ease, transform 100ms ease, box-shadow 120ms ease; }
			.zc-context-menu-item:hover { background:color-mix(in srgb, var(--zc-surface) 72%, rgba(64,101,161,0.12)); box-shadow:0 0 0 1px color-mix(in srgb, var(--zc-user-border) 26%, transparent); }
			.zc-context-menu-item:active { transform:translateX(1px); background:color-mix(in srgb, var(--zc-surface) 64%, rgba(64,101,161,0.18)); box-shadow:inset 0 1px 2px rgba(0,0,0,0.10); }
			.zc-composer-resizebar { height:10px; margin:1px 0 1px; cursor:ns-resize; border-radius:999px; background:linear-gradient(180deg, transparent 0 40%, var(--zc-soft-border) 40% 60%, transparent 60% 100%); }
			.zc-composer-resizebar:hover { background:linear-gradient(180deg, transparent 0 35%, var(--zc-border) 35% 65%, transparent 65% 100%); }
			.zc-input { min-height:96px; height:96px; padding:8px 10px; resize:none; font:13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
			.zc-input.is-dragging { outline: 2px solid rgba(64,101,161,0.28); background: color-mix(in srgb, var(--zc-surface-strong) 88%, rgba(64,101,161,0.12)); }
			.zc-composer-profile-row { justify-content:space-between; width:100%; min-width:0; margin-bottom:6px; }
			.zc-composer-footer { justify-content:space-between; align-items:center; gap:8px; flex-wrap:nowrap; min-width:0; margin-top:8px; }
			.zc-composer-submit { flex:1 1 auto; min-width:0; justify-content:flex-end; flex-wrap:nowrap; }
			.zc-composer-secondary-actions { flex:1 1 auto; min-width:0; justify-content:flex-end; flex-wrap:wrap; }
			.zc-composer-submit > .zc-btn-primary { flex:0 0 auto; min-height:28px; }
			.zc-send-label { display:inline-block; min-width:72px; text-align:center; }
			@keyframes zc-fade-in { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:translateY(0); } }
		`;
	},

	async refreshSessions(state, { targetSessionID = null } = {}) {
		state.sessions = await this.getAllSessions();
		if (!state.sessions.length) state.sessions = [await this.createSession()];
		let sessionID = targetSessionID || state.currentSession?.data?.sessionID || state.sessions[0]?.data?.sessionID || null;
		await this.switchToSession(state, sessionID);
	},

	async switchToSession(state, sessionID) {
		let session = state.sessions.find((entry) => entry.data.sessionID === sessionID) || state.sessions[0] || null;
		if (!session) return;
		let previousSessionID = state.currentSession?.data?.sessionID || null;
		if (state.isSending && session.data.sessionID !== state.currentSession?.data?.sessionID) {
			this.setStatus(state, "生成过程中暂不允许切换会话", true);
			return;
		}
		if (session.data.sessionID !== state.currentSession?.data?.sessionID) {
			state.editTargetMessageID = null;
			state.editTargetRole = null;
			state.pendingSourceRefs = [];
			state.input.value = "";
			this.renderPendingSources(state);
		}
		state.currentSession = session;
		this.renderCurrentSession(state);
		this.setStatus(state, previousSessionID === session.data.sessionID ? `当前会话：${this.getSessionTitle(session.data)}` : `已切换到会话：${this.getSessionTitle(session.data)}`);
	},

	renderCurrentSession(state) {
		if (!state.currentSession) return;
		state.sessionSelect.setAttribute("tooltiptext", `选择会话：${this.getSessionTitle(state.currentSession.data)}`);
		this.updateSendButton(state);
		this.renderSessionMenu(state);
		this.renderProfileMenu(state);
		this.renderPromptMenu(state);
		this.renderMessages(state, state.currentSession.data.messages || []);
		this.setStatus(state, "");
	},

	renderSessionMenu(state) {
		let selectedSessionID = state.currentSession?.data?.sessionID || "";
		state.sessionSelect.textContent = "";
		for (let session of state.sessions || []) {
			state.sessionSelect.appendChild(this.createSelectOption(state.doc, this.getSessionTitle(session.data), session.data.sessionID));
		}
		state.sessionSelect.value = selectedSessionID || state.sessionSelect.value || state.sessionSelect.options?.[0]?.value || "";
	},

	toggleSessionMenu(state) {
		state.sessionSelect?.focus?.();
		state.sessionSelect?.click?.();
	},

	hideSessionMenu(state) {
		state.isSessionMenuOpen = false;
	},

	renderProfileMenu(state) {
		let profiles = this.getLLMProfiles();
		let activeID = this.getActiveLLMProfileID();
		state.profileSelect.textContent = "";
		for (let profile of profiles) {
			let providerName = profile.provider?.name || profile.providerName || "";
			let label = `${providerName ? providerName + " · " : ""}${profile.name || profile.model || "未命名模型"}${profile.id === activeID ? " (当前)" : ""}`;
			state.profileSelect.appendChild(this.createSelectOption(state.doc, label, profile.id));
		}
		state.profileSelect.value = activeID || state.profileSelect.value || state.profileSelect.options?.[0]?.value || "";
	},

	renderPromptMenu(state) {
		let prompts = this.getSystemPromptProfiles();
		let activeID = this.getActiveSystemPromptID();
		state.promptSelect.textContent = "";
		for (let prompt of prompts) {
			let label = `${prompt.name}${prompt.id === activeID ? " (当前)" : ""}`;
			state.promptSelect.appendChild(this.createSelectOption(state.doc, label, prompt.id));
		}
		state.promptSelect.value = activeID || state.promptSelect.value || state.promptSelect.options?.[0]?.value || "";
	},

	toggleProfileMenu(state) {
		state.profileSelect?.focus?.();
		state.profileSelect?.click?.();
	},

	hideProfileMenu(state) {
		state.isProfileMenuOpen = false;
	},

	selectProfile(state, profileID) {
		if (!this.setActiveLLMProfileID(profileID)) {
			this.setStatus(state, "模型配置不存在", true);
			return;
		}
		this.renderProfileMenu(state);
		let activeProfile = this.getActiveLLMProfile();
		let providerName = activeProfile?.provider?.name ? `${activeProfile.provider.name} / ` : "";
		this.setStatus(state, `已切换到模型：${providerName}${activeProfile?.name || activeProfile?.model || profileID}`);
	},

	selectSystemPrompt(state, promptID) {
		if (!this.setActiveSystemPromptID(promptID)) {
			this.setStatus(state, "系统提示词配置不存在", true);
			return;
		}
		this.renderPromptMenu(state);
		let prompt = this.getActiveSystemPrompt();
		this.setStatus(state, `已切换到系统提示词：${prompt?.name || "未命名提示词"}`);
	},

	resolveAPIEndpoint(baseURL, path = "") {
		let normalizedBase = String(baseURL || "").trim().replace(/\/+$/, "");
		let normalizedPath = String(path || "").trim();
		if (!normalizedBase) return normalizedPath;
		if (!normalizedPath) return normalizedBase;
		if (/^https?:\/\//i.test(normalizedPath)) return normalizedPath;
		return normalizedBase + (normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`);
	},

	openSettingsPane(state) {
		this.hideProfileMenu(state);
		let attempts = [
			() => {
				if (typeof Zotero.PreferencePanes?.open !== "function") return false;
				Zotero.PreferencePanes.open({ pluginID: this.id, id: this.PREF_PANE_ID });
				return true;
			},
			() => {
				if (typeof Zotero.PreferencePanes?.open !== "function") return false;
				Zotero.PreferencePanes.open({ pluginID: this.id });
				return true;
			},
			() => {
				if (typeof Zotero.PreferencePanes?.open !== "function") return false;
				Zotero.PreferencePanes.open({ id: this.PREF_PANE_ID });
				return true;
			},
			() => {
				if (typeof Zotero.PreferencePanes?.open !== "function") return false;
				Zotero.PreferencePanes.open(this.PREF_PANE_ID);
				return true;
			},
			() => {
				if (typeof Zotero.PreferencePanes?.open !== "function") return false;
				Zotero.PreferencePanes.open(this.id);
				return true;
			},
			() => {
				if (typeof state.window.ZoteroPane?.openPreferences !== "function") return false;
				state.window.ZoteroPane.openPreferences(this.PREF_PANE_ID);
				return true;
			},
			() => {
				if (typeof state.window.ZoteroPane?.openPreferences !== "function") return false;
				state.window.ZoteroPane.openPreferences(this.id);
				return true;
			},
			() => {
				if (typeof state.window.ZoteroPane?.openPreferences !== "function") return false;
				state.window.ZoteroPane.openPreferences();
				return true;
			},
			() => {
				if (typeof Zotero.Utilities?.Internal?.openPreferences !== "function") return false;
				Zotero.Utilities.Internal.openPreferences(this.id);
				return true;
			}
		];
		for (let attempt of attempts) {
			try {
				if (attempt()) return;
			}
			catch (_e) {}
		}
		this.setStatus(state, "无法打开设置，请从 Zotero 插件设置页手动进入", true);
	},

	getSessionTitle(sessionData) {
		if (!sessionData) return this.DEFAULT_SESSION_TITLE;
		let base = String(sessionData.title || "").trim();
		if (base) return base;
		let number = Number(sessionData.number);
		return Number.isFinite(number) && number > 0 ? `会话 ${number}` : this.DEFAULT_SESSION_TITLE;
	},

	makeDuplicatedSessionTitle(sessionData) {
		let title = this.getSessionTitle(sessionData);
		return /副本$/.test(title) ? title : `${title} 副本`;
	},

	cloneSessionData(session) {
		let sessionData = session?.data || session || {};
		let now = new Date().toISOString();
		let cloned = JSON.parse(JSON.stringify(sessionData || {}));
		cloned.sessionID = this.makeSessionStorageKey(now);
		cloned.title = this.makeDuplicatedSessionTitle(sessionData);
		cloned.createdAt = now;
		cloned.updatedAt = now;
		cloned.version = 1;
		delete cloned.number;
		return this.normalizeSessionData(cloned);
	},

	handleMessagesCopy(state, event) {
		let selection = state.doc.defaultView?.getSelection?.() || state.doc.getSelection?.();
		if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
		let anchorRoot = selection.anchorNode?.nodeType === 1 ? selection.anchorNode : selection.anchorNode?.parentElement;
		let focusRoot = selection.focusNode?.nodeType === 1 ? selection.focusNode : selection.focusNode?.parentElement;
		if (!anchorRoot?.closest?.(".zc-markdown") && !focusRoot?.closest?.(".zc-markdown")) return;
		let fragment = selection.getRangeAt(0).cloneContents();
		let markdown = this.normalizeCopiedMarkdown(this.serializeFragmentToMarkdown(fragment));
		if (!markdown) return;
		event.preventDefault();
		event.clipboardData?.setData("text/plain", markdown);
		event.clipboardData?.setData("text/markdown", markdown);
	},

	async handleCloneCurrentSession(state) {
		let session = state.currentSession;
		if (!session) return;
		if (state.isSending) {
			this.setStatus(state, "生成过程中暂不允许复制会话", true);
			return;
		}
		let cloned = {
			store: session.store || await this.ensureConversationStore(),
			item: session.item || null,
			attachment: null,
			data: this.cloneSessionData(session)
		};
		await this.saveSession(cloned);
		await this.refreshSessions(state, { targetSessionID: cloned.data.sessionID });
		this.setStatus(state, `已创建会话副本：${this.getSessionTitle(cloned.data)}`);
	},

	renderPendingSources(state) {
		let sourceRefs = state.pendingSourceRefs || [];
		state.composerSources.textContent = "";
		state.composerSources.style.display = sourceRefs.length ? "flex" : "none";
		for (let sourceRef of sourceRefs) {
			let chip = this.html(state.doc, "div", { className: "zc-chip zc-source-jump" });
			chip.dataset.libraryId = String(sourceRef.libraryID || "");
			chip.dataset.itemKey = String(sourceRef.itemKey || "");
			chip.dataset.parentItemKey = String(sourceRef.parentItemKey || "");
			chip.appendChild(this.html(state.doc, "span", { className: "zc-chip-label", textContent: sourceRef.label || sourceRef.itemKey || sourceRef.sourceID }));
			let remove = this.html(state.doc, "button", { className: "zc-chip-remove", type: "button", textContent: "✕" });
			remove.addEventListener("click", () => this.removePendingSource(state, sourceRef.sourceID));
			chip.appendChild(remove);
			state.composerSources.appendChild(chip);
		}
		this.updateSendButton(state);
	},

	renderMessages(state, messages) {
		state.messages.textContent = "";
		if (!messages.length) {
			state.emptyState.style.display = "";
			state.messages.classList.remove("has-messages");
			return;
		}
		state.emptyState.style.display = "none";
		state.messages.classList.add("has-messages");
		for (let message of messages) {
			state.messages.appendChild(this.buildMessageNode(state.doc, message, {
				isEditing: state.editTargetMessageID === message.messageID
			}));
		}
		state.messages.scrollTop = state.messages.scrollHeight;
	},

	buildMessageNode(doc, message, { isEditing = false } = {}) {
		let wrap = this.html(doc, "div", { className: `zc-message ${message.error ? "zc-message-error" : (message.role === "user" ? "zc-message-user" : "zc-message-assistant")}${isEditing ? " is-editing" : ""}` });
		let top = this.html(doc, "div", { className: "zc-message-top" });
		top.appendChild(this.html(doc, "div", { className: "zc-message-role", textContent: message.error ? "error" : message.role }));
		let actions = this.html(doc, "div", { className: "zc-message-actions" });
		if (!message.error && (message.role === "user" || message.role === "assistant")) {
			let editButton = this.html(doc, "button", { className: "zc-message-action", type: "button", textContent: "✎" });
			editButton.dataset.action = message.role === "user" ? "edit-user" : "edit-assistant";
			editButton.dataset.messageId = message.messageID;
			editButton.setAttribute("title", message.role === "user" ? "编辑消息" : "编辑回答");
			actions.appendChild(editButton);
		}
		if (actions.childElementCount) {
			top.appendChild(actions);
		}
		wrap.appendChild(top);
		if (Array.isArray(message.sourceRefs) && message.sourceRefs.length) {
			let sources = this.html(doc, "div", { className: "zc-message-sources" });
			for (let sourceRef of message.sourceRefs) {
				let chip = this.html(doc, "div", { className: "zc-chip zc-source-jump" });
				chip.dataset.libraryId = String(sourceRef.libraryID || "");
				chip.dataset.itemKey = String(sourceRef.itemKey || "");
				chip.dataset.parentItemKey = String(sourceRef.parentItemKey || "");
				chip.appendChild(this.html(doc, "span", { className: "zc-chip-label", textContent: sourceRef.label || sourceRef.itemKey || sourceRef.sourceID }));
				sources.appendChild(chip);
			}
			wrap.appendChild(sources);
		}
		if (message.reasoning) {
			let reasoningWrap = this.html(doc, "details", { className: "zc-message-reasoning" });
			if (message.reasoningCollapsed !== false) {
				reasoningWrap.removeAttribute("open");
			}
			else {
				reasoningWrap.setAttribute("open", "open");
			}
			reasoningWrap.appendChild(this.html(doc, "summary", { className: "zc-message-reasoning-summary", textContent: "Thought process" }));
			let reasoningBody = this.html(doc, "div", { className: "zc-message-reasoning-body zc-markdown" });
			this.setMarkdownContent(reasoningBody, message.reasoning);
			reasoningWrap.appendChild(reasoningBody);
			wrap.appendChild(reasoningWrap);
		}
		let body = this.html(doc, "div", { className: "zc-message-body zc-markdown" });
		this.setMarkdownContent(body, message.error || message.content || "");
		wrap.appendChild(body);
		return wrap;
	},

	ensureReasoningNode(streaming) {
		if (streaming.reasoningWrapEl && streaming.reasoningBodyEl) return;
		let reasoningWrap = this.html(streaming.node.ownerDocument, "details", {
			className: "zc-message-reasoning"
		});
		reasoningWrap.setAttribute("open", "open");
		reasoningWrap.appendChild(this.html(streaming.node.ownerDocument, "summary", {
			className: "zc-message-reasoning-summary",
			textContent: "Thought process"
		}));
		let reasoningBody = this.html(streaming.node.ownerDocument, "div", {
			className: "zc-message-reasoning-body zc-markdown",
			textContent: ""
		});
		reasoningWrap.appendChild(reasoningBody);
		streaming.node.insertBefore(reasoningWrap, streaming.bodyEl);
		streaming.reasoningWrapEl = reasoningWrap;
		streaming.reasoningBodyEl = reasoningBody;
		streaming.reasoningRender = this.createStreamingRenderState(reasoningBody);
	},

	appendStreamingAssistantMessage(state) {
		state.emptyState.style.display = "none";
		state.messages.classList.add("has-messages");
		let message = { messageID: this.makeID("assistant"), role: "assistant", content: "", reasoning: "", reasoningCollapsed: false, createdAt: new Date().toISOString() };
		let node = this.buildMessageNode(state.doc, message);
		state.messages.appendChild(node);
		let bodyEl = node.querySelector(".zc-message-body");
		bodyEl.textContent = "。";
		let tick = 0;
		let waitTimer = state.window.setInterval(() => {
			tick = (tick + 1) % 3;
			bodyEl.textContent = "。".repeat(tick + 1);
		}, 400);
		return {
			message,
			node,
			bodyEl,
			contentRender: this.createStreamingRenderState(bodyEl),
			reasoningWrapEl: node.querySelector(".zc-message-reasoning"),
			reasoningBodyEl: node.querySelector(".zc-message-reasoning-body"),
			reasoningRender: node.querySelector(".zc-message-reasoning-body") ? this.createStreamingRenderState(node.querySelector(".zc-message-reasoning-body")) : null,
			stopWaiting: () => {
				if (waitTimer) {
					state.window.clearInterval(waitTimer);
					waitTimer = null;
				}
			}
		};
	},

	async handleNewChat(state) {
		let session = await this.createSession();
		state.pendingSourceRefs = [];
		state.editTargetMessageID = null;
		state.editTargetRole = null;
		this.renderPendingSources(state);
		await this.refreshSessions(state, { targetSessionID: session.data.sessionID });
		this.setStatus(state, "已新建会话");
	},

	canAcceptDrop(window, event, options = {}) {
		return this.extractDroppedItems(window, event, options).length > 0;
	},

	extractDroppedItems(window, event, { allowSelectionFallback = false } = {}) {
		let dt = event?.dataTransfer;
		if (!dt) return [];
		let items = [];
		let seen = new Set();
		for (let typeName of ["application/x-zotero-item", "zotero/item", "text/x-zotero-item", "text/x-zotero-items"]) {
			try {
				let raw = dt.getData(typeName);
				if (!raw) continue;
				for (let match of raw.matchAll(/\d+/g)) {
					let id = parseInt(match[0], 10);
					if (!Number.isFinite(id) || seen.has(id)) continue;
					let item = Zotero.Items.get(id);
					if (item) {
						seen.add(id);
						items.push(item);
					}
				}
			}
			catch (_e) {}
		}
		if (items.length) return items;
		if (allowSelectionFallback) {
			try {
				if (dt.mozSourceNode?.ownerDocument === window.document) {
					return window.ZoteroPane?.getSelectedItems?.() || [];
				}
			}
			catch (_e) {}
		}
		return [];
	},

	async handleDrop(state, event) {
		await this.addPendingItemsToComposer(state, this.extractDroppedItems(state.window, event, { allowSelectionFallback: true }));
	},

	async addPendingItemsToComposer(state, items) {
		if (!items.length) return;
		let addedCount = 0;
		let skipped = [];
		this.setStatus(state, "正在提取上下文...");
		for (let item of items) {
			let result = await this.resolveContextSource(item, state.window).catch((e) => ({ ok: false, reason: e.message || String(e) }));
			if (!result?.ok) {
				skipped.push(result?.reason || "无法解析该条目");
				continue;
			}
			if ((state.pendingSourceRefs || []).some((entry) => entry.sourceID === result.sourceRef.sourceID)) {
				continue;
			}
			state.pendingSourceRefs.push(result.sourceRef);
			addedCount += 1;
		}
		this.renderPendingSources(state);
		let parts = [];
		if (addedCount) parts.push(`已添加 ${addedCount} 个上下文`);
		if (skipped.length) parts.push(`跳过 ${skipped.length} 个：${skipped[0]}`);
		this.setStatus(state, parts.join("；") || "没有可添加的上下文", skipped.length > 0 && !addedCount);
	},

	removePendingSource(state, sourceID) {
		state.pendingSourceRefs = (state.pendingSourceRefs || []).filter((entry) => entry.sourceID !== sourceID);
		this.renderPendingSources(state);
		this.setStatus(state, "已移除上下文");
	},

	getEditTargetMessage(state) {
		let session = state.currentSession;
		if (!session || !state.editTargetMessageID) return null;
		let index = this.findMessageIndex(session.data.messages, state.editTargetMessageID);
		if (index < 0) return null;
		return {
			session,
			index,
			message: session.data.messages[index]
		};
	},

	async saveEditedMessage(state) {
		let editTarget = this.getEditTargetMessage(state);
		if (!editTarget) return;
		let nextContent = String(state.input.value || "").trim();
		if (!nextContent) {
			this.setStatus(state, "消息内容不能为空", true);
			return;
		}
		let updatedMessage = {
			...editTarget.message,
			content: nextContent,
			editedAt: new Date().toISOString()
		};
		if (updatedMessage.role === "user") {
			updatedMessage.sourceRefs = (state.pendingSourceRefs || []).map((entry) => ({ ...entry }));
		}
		editTarget.session.data.messages[editTarget.index] = updatedMessage;
		editTarget.session.data.updatedAt = new Date().toISOString();
		await this.saveSession(editTarget.session);
		let sessionID = editTarget.session.data.sessionID;
		this.cancelEdit(state);
		await this.refreshSessions(state, { targetSessionID: sessionID });
		this.setStatus(state, updatedMessage.role === "assistant" ? "已保存回答修改" : "已保存消息修改");
	},

	async handleSend(state) {
		if (state.isSending) return;
		if (state.editTargetMessageID) {
			await this.saveEditedMessage(state);
			return;
		}
		let prompt = String(state.input.value || "").trim();
		if (!prompt) return;
		let session = state.currentSession || await this.createSession();
		state.currentSession = session;
		let pendingSources = (state.pendingSourceRefs || []).map((entry) => ({ ...entry }));
		let userMessage = {
			messageID: state.editTargetMessageID || this.makeID("user"),
			role: "user",
			content: prompt,
			sourceRefs: pendingSources,
			createdAt: new Date().toISOString(),
			editedAt: state.editTargetMessageID ? new Date().toISOString() : undefined
		};
		let replaceFromMessageID = state.editTargetMessageID;
		state.pendingSourceRefs = [];
		state.editTargetMessageID = null;
		this.renderPendingSources(state);
		state.input.value = "";
		await this.runUserTurn(state, {
			session,
			userMessage,
			replaceFromMessageID,
			regenerateExistingUser: !!replaceFromMessageID
		});
	},

	async handleRegenerate(state) {
		if (state.isSending) return;
		if (!state.editTargetMessageID || state.editTargetRole !== "user") return;
		let prompt = String(state.input.value || "").trim();
		if (!prompt) return;
		let session = state.currentSession || await this.createSession();
		state.currentSession = session;
		let pendingSources = (state.pendingSourceRefs || []).map((entry) => ({ ...entry }));
		let userMessage = {
			messageID: state.editTargetMessageID,
			role: "user",
			content: prompt,
			sourceRefs: pendingSources,
			createdAt: new Date().toISOString(),
			editedAt: new Date().toISOString()
		};
		let replaceFromMessageID = state.editTargetMessageID;
		state.pendingSourceRefs = [];
		state.editTargetMessageID = null;
		state.editTargetRole = null;
		this.renderPendingSources(state);
		state.input.value = "";
		await this.runUserTurn(state, {
			session,
			userMessage,
			replaceFromMessageID,
			regenerateExistingUser: true
		});
	},

	makeSessionTitle(prompt) {
		let text = String(prompt || "").replace(/\s+/g, " ").trim();
		return !text ? this.DEFAULT_SESSION_TITLE : (text.length > 50 ? text.slice(0, 50) + "…" : text);
	},

	buildAutoTitleMessages(userPrompt, sourceRefs = []) {
		let firstUser = String(userPrompt || "").trim();
		let sourceNames = Array.from(new Set((sourceRefs || []).map((entry) => String(entry?.label || "").trim()).filter(Boolean)));
		let sourceBlock = sourceNames.length ? `Context source titles:\n- ${sourceNames.join("\n- ")}\n\n` : "";
		return [
			{
				role: "system",
				content: "You generate concise chat titles for Zotero conversations. Use the conversation language. Return only the title text, with no quotes, labels, markdown, or explanation. Keep it short and specific."
			},
			{
				role: "user",
				content: `${sourceBlock}First user message:\n${firstUser}\n\nGenerate one concise title for this conversation.`
			}
		];
	},

	normalizeGeneratedSessionTitle(rawTitle, fallbackPrompt = "") {
		let text = String(rawTitle || "").replace(/\r\n?/g, "\n").trim();
		if (text.startsWith("```")) {
			text = text.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "").trim();
		}
		text = text.split("\n").map((line) => line.trim()).filter(Boolean)[0] || "";
		text = text
			.replace(/^#+\s*/, "")
			.replace(/^[-*]\s+/, "")
			.replace(/^(title|标题)\s*[:：]\s*/i, "")
			.replace(/^["'“”‘’]+/, "")
			.replace(/["'“”‘’]+$/, "")
			.replace(/\s+/g, " ")
			.trim();
		return text ? this.makeSessionTitle(text) : this.makeSessionTitle(fallbackPrompt);
	},

	async generateSessionTitle({ userPrompt, sourceRefs = [], signal = null }) {
		let llm = this.getTitleLLMSettings();
		let title = await this.requestMessagesCompletion({
			llm,
			messages: this.buildAutoTitleMessages(userPrompt, sourceRefs),
			signal,
			allowStream: false
		});
		return this.normalizeGeneratedSessionTitle(title, userPrompt);
	},

	async handleRenameCurrentSession(state) {
		let session = state.currentSession;
		if (!session) return;
		if (state.isSending) {
			this.setStatus(state, "生成过程中暂不允许重命名会话", true);
			return;
		}
		let nextTitle = state.window.prompt("输入新的会话标题", this.getSessionTitle(session.data));
		if (nextTitle === null) return;
		nextTitle = String(nextTitle || "").trim();
		session.data.title = nextTitle;
		session.data.updatedAt = new Date().toISOString();
		await this.saveSession(session);
		await this.refreshSessions(state, { targetSessionID: session.data.sessionID });
		this.setStatus(state, "已重命名会话");
	},

	async handleDeleteCurrentSession(state) {
		let session = state.currentSession;
		if (!session) return;
		if (state.isSending) {
			this.setStatus(state, "生成过程中暂不允许删除会话", true);
			return;
		}
		let title = this.getSessionTitle(session.data);
		let confirmed = state.window.confirm(`确定删除会话“${title}”吗？此操作不可撤销。`);
		if (!confirmed) return;
		let deletedSessionID = session.data.sessionID;
		let nextSessionID = (state.sessions || []).find((entry) => entry.data.sessionID !== deletedSessionID)?.data?.sessionID || null;
		await this.deleteSessionAttachment(session);
		state.pendingSourceRefs = [];
		state.editTargetMessageID = null;
		state.editTargetRole = null;
		state.input.value = "";
		this.renderPendingSources(state);
		await this.refreshSessions(state, { targetSessionID: nextSessionID });
		this.setStatus(state, `已删除会话：${title}`);
	},

	findMessageIndex(messages, messageID) {
		return (messages || []).findIndex((entry) => entry.messageID === messageID);
	},

	findPreviousUserMessage(messages, assistantMessageID) {
		let index = this.findMessageIndex(messages, assistantMessageID);
		if (index < 0) return null;
		for (let i = index - 1; i >= 0; i--) {
			if (messages[i]?.role === "user") return messages[i];
		}
		return null;
	},

	async handleMessageAction(state, action, messageID) {
		let session = state.currentSession;
		if (!session) return;
		if (action === "edit-user" || action === "edit-assistant") {
			let index = this.findMessageIndex(session.data.messages, messageID);
			if (index < 0) return;
			let message = session.data.messages[index];
			state.input.value = message.content || "";
			state.pendingSourceRefs = action === "edit-user" ? (message.sourceRefs || []).map((entry) => ({ ...entry })) : [];
			state.editTargetMessageID = messageID;
			state.editTargetRole = message.role || null;
			this.renderPendingSources(state);
			this.renderMessages(state, session.data.messages || []);
			this.inputFocus(state);
			this.setStatus(state, action === "edit-assistant" ? "已载入回答，修改后点击 Save" : "已载入该轮消息，可点击 Save 或 Regenerate");
		}
	},

	async runUserTurn(state, { session, userMessage, replaceFromMessageID = null, regenerateExistingUser = false }) {
		let requestID = this.makeID("request");
		state.isSending = true;
		let AbortCtor = typeof AbortController !== "undefined" ? AbortController : state.window?.AbortController;
		state.requestAbortController = AbortCtor ? new AbortCtor() : null;
		state.stopRequested = false;
		state.currentStreamReader = null;
		state.activeRequestID = requestID;
		state.currentStreaming = null;
		state.sendButton.disabled = true;
		state.input.disabled = true;
		this.updateSendButton(state);

		let messages = Array.isArray(session.data.messages) ? [...session.data.messages] : [];
		if (replaceFromMessageID) {
			let replaceIndex = this.findMessageIndex(messages, replaceFromMessageID);
			if (replaceIndex >= 0) {
				let replaceMessage = messages[replaceIndex];
				if (replaceMessage.role === "assistant") {
					let previousUser = this.findPreviousUserMessage(messages, replaceFromMessageID);
					let previousUserIndex = previousUser ? this.findMessageIndex(messages, previousUser.messageID) : replaceIndex;
					messages = messages.slice(0, Math.max(previousUserIndex, 0));
				}
				else {
					messages = messages.slice(0, replaceIndex);
				}
			}
		}
		let shouldAutoTitle = (
			userMessage.role === "user"
			&& !replaceFromMessageID
			&& !session.data.autoTitleLocked
			&& !messages.some((entry) => entry?.role === "user")
		);
		if (!regenerateExistingUser || replaceFromMessageID === null || userMessage.role !== "user") {
			messages.push(userMessage);
		}
		else {
			messages.push(userMessage);
		}
		session.data.messages = messages;
		if (shouldAutoTitle) {
			try {
				session.data.title = await this.generateSessionTitle({
					userPrompt: userMessage.content || "",
					sourceRefs: userMessage.sourceRefs || [],
					signal: state.requestAbortController?.signal || null
				});
			}
			catch (titleError) {
				this.log(`Auto title generation failed: ${titleError}`);
				session.data.title = this.makeSessionTitle(userMessage.content || "");
			}
			session.data.autoTitleLocked = true;
		}
		session.data.updatedAt = new Date().toISOString();
		this.renderCurrentSession(state);
		await this.saveSession(session);

		let streaming = this.appendStreamingAssistantMessage(state);
		state.currentStreaming = {
			requestID,
			session,
			streaming,
			finalized: false
		};
		this.setStatus(state, "正在请求模型...");
		try {
			let reply = await this.requestChatCompletion({
				session: session.data,
				signal: state.requestAbortController?.signal,
				onReader: (reader) => {
					state.currentStreamReader = reader || null;
				},
				onDelta: ({ type, text }) => {
					if (state.stopRequested || state.activeRequestID !== requestID) return;
					if (type === "reasoning") {
						streaming.stopWaiting();
						this.ensureReasoningNode(streaming);
						streaming.message.reasoning += text;
						this.updateStreamingText(state, streaming.reasoningRender, streaming.message.reasoning);
						if (!streaming.message.content) {
							this.finalizeStreamingText(state, streaming.contentRender, "");
						}
						return;
					}
					streaming.stopWaiting();
					streaming.message.content += text;
					streaming.message.reasoningCollapsed = true;
					if (streaming.reasoningWrapEl) {
						streaming.reasoningWrapEl.removeAttribute("open");
					}
					this.updateStreamingText(state, streaming.contentRender, streaming.message.content || "。。。");
				}
			});
			if (state.activeRequestID !== requestID || state.stopRequested) {
				return;
			}
			streaming.stopWaiting();
			streaming.message.content = reply;
			this.finalizeStreamingText(state, streaming.contentRender, reply, { forceScroll: true });
			if (streaming.reasoningRender) {
				this.finalizeStreamingText(state, streaming.reasoningRender, streaming.message.reasoning || "");
			}
			session.data.messages.push(streaming.message);
			session.data.updatedAt = new Date().toISOString();
			await this.saveSession(session);
			await this.refreshSessions(state, { targetSessionID: session.data.sessionID });
			if (state.currentStreaming?.requestID === requestID) {
				state.currentStreaming.finalized = true;
				state.currentStreaming = null;
			}
			this.setStatus(state, "已完成");
		}
		catch (e) {
			if (state.activeRequestID !== requestID || state.stopRequested) {
				return;
			}
			streaming.stopWaiting();
			this.cancelStreamingRender(state, streaming.contentRender);
			this.cancelStreamingRender(state, streaming.reasoningRender);
			streaming.node.remove();
			if (e?.name === "AbortError") {
				if (streaming.message.reasoning || streaming.message.content) {
					streaming.message.stopped = true;
					streaming.message.stoppedAt = new Date().toISOString();
					session.data.messages.push(streaming.message);
					session.data.updatedAt = new Date().toISOString();
					await this.saveSession(session);
					this.renderCurrentSession(state);
				}
				if (state.currentStreaming?.requestID === requestID) {
					state.currentStreaming.finalized = true;
					state.currentStreaming = null;
				}
				this.setStatus(state, "已停止生成");
				return;
			}
			session.data.messages.push({
				messageID: this.makeID("assistant-error"),
				role: "assistant",
				content: "",
				error: e.message || String(e),
				createdAt: new Date().toISOString()
			});
			session.data.updatedAt = new Date().toISOString();
			await this.saveSession(session);
			this.renderCurrentSession(state);
			if (state.currentStreaming?.requestID === requestID) {
				state.currentStreaming.finalized = true;
				state.currentStreaming = null;
			}
			this.setStatus(state, `请求失败：${e.message || e}`, true);
		}
		finally {
			if (state.activeRequestID === requestID || state.activeRequestID === null) {
				state.isSending = false;
				state.requestAbortController = null;
				state.currentStreamReader = null;
				state.stopRequested = false;
				state.activeRequestID = null;
				state.sendButton.disabled = false;
				state.input.disabled = false;
				this.updateSendButton(state);
			}
		}
	},

	getLLMSettingsForProfile(profileID = "") {
		let profile = profileID ? this.getLLMProfiles().find((entry) => entry.id === profileID) : null;
		if (!profile) {
			profile = this.getActiveLLMProfile();
		}
		return {
			apiBaseURL: String(profile?.provider?.apiBaseURL || "").trim().replace(/\/+$/, ""),
			apiKey: String(profile?.provider?.apiKey || "").trim().replace(/^Bearer\s+/i, ""),
			model: String(profile?.model || "").trim(),
			requestJSON: String(profile?.requestJSON || "").trim(),
			profileID: profile?.id || "",
			profileName: profile?.name || "",
			providerID: profile?.provider?.id || profile?.providerID || "",
			providerName: profile?.provider?.name || "",
			chatPath: String(profile?.provider?.chatPath || "/chat/completions").trim() || "/chat/completions"
		};
	},

	getLLMSettings() {
		return this.getLLMSettingsForProfile(this.getActiveLLMProfileID());
	},

	getStoredTitleLLMProfileID() {
		return String(Zotero.Prefs.get(this.PREF_BRANCH + "titleLLMProfileID", true) || "").trim();
	},

	resolveTitleLLMProfileID() {
		let storedID = this.getStoredTitleLLMProfileID();
		if (!storedID) return this.getActiveLLMProfileID();
		let matched = this.getLLMProfiles().find((profile) => profile.id === storedID);
		if (matched) return matched.id;
		this.setStringPref("titleLLMProfileID", "");
		return this.getActiveLLMProfileID();
	},

	getTitleLLMSettings() {
		return this.getLLMSettingsForProfile(this.resolveTitleLLMProfileID());
	},

	getLegacyLLMSettings() {
		return {
			apiBaseURL: String(Zotero.Prefs.get(this.PREF_BRANCH + "llmApiBaseURL", true) || "").trim().replace(/\/+$/, ""),
			apiKey: String(Zotero.Prefs.get(this.PREF_BRANCH + "llmApiKey", true) || "").trim().replace(/^Bearer\s+/i, ""),
			model: String(Zotero.Prefs.get(this.PREF_BRANCH + "llmModel", true) || "").trim(),
			requestJSON: String(Zotero.Prefs.get(this.PREF_BRANCH + "llmRequestJSON", true) || "").trim()
		};
	},

	readJSONPrefArray(name) {
		let raw = String(Zotero.Prefs.get(this.PREF_BRANCH + name, true) || "").trim();
		if (!raw) return [];
		try {
			let parsed = JSON.parse(raw);
			return Array.isArray(parsed) ? parsed : [];
		}
		catch (e) {
			this.log(`Invalid ${name}: ${e}`);
			return [];
		}
	},

	inferProviderName(apiBaseURL, fallback = "") {
		let normalizedURL = String(apiBaseURL || "").trim();
		if (normalizedURL) {
			try {
				let host = new URL(normalizedURL).hostname.replace(/^www\./i, "");
				let known = [
					["api.openai.com", "OpenAI"],
					["openrouter.ai", "OpenRouter"],
					["api.deepseek.com", "DeepSeek"],
					["generativelanguage.googleapis.com", "Google AI"],
					["api.anthropic.com", "Anthropic"],
					["dashscope.aliyuncs.com", "DashScope"],
					["api.moonshot.cn", "Moonshot"],
					["api.siliconflow.cn", "SiliconFlow"],
					["ark.cn-beijing.volces.com", "Volcengine Ark"]
				];
				for (let [domain, label] of known) {
					if (host === domain) return label;
				}
				return host;
			}
			catch (_e) {}
		}
		return String(fallback || "供应商").trim() || "供应商";
	},

	makeLLMProviderID() {
		return `provider-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	},

	makeLLMModelID() {
		return `model-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	},

	normalizeLLMProvider(provider, index = 0) {
		if (!provider || typeof provider !== "object") return null;
		let id = String(provider.id || `provider-${index + 1}`).trim() || `provider-${index + 1}`;
		let apiBaseURL = String(provider.apiBaseURL || "").trim().replace(/\/+$/, "");
		let fallbackName = provider.name || this.inferProviderName(apiBaseURL, `供应商 ${index + 1}`);
		return {
			id,
			name: String(fallbackName || "").trim() || `供应商 ${index + 1}`,
			apiBaseURL,
			apiKey: String(provider.apiKey || "").trim().replace(/^Bearer\s+/i, ""),
			modelsPath: String(provider.modelsPath || "/models").trim() || "/models",
			chatPath: String(provider.chatPath || "/chat/completions").trim() || "/chat/completions"
		};
	},

	getLLMProfiles() {
		let { providers, profiles } = this.ensureLLMConfigStore();
		let providersByID = new Map(providers.map((provider) => [provider.id, provider]));
		return profiles.map((profile) => ({
			...profile,
			provider: providersByID.get(profile.providerID) || null
		}));
	},

	normalizeLLMProfile(profile, index = 0) {
		if (!profile || typeof profile !== "object") return null;
		let id = String(profile.id || `model-${index + 1}`).trim();
		if (!id) id = `model-${index + 1}`;
		return {
			id,
			providerID: String(profile.providerID || "").trim(),
			name: String(profile.name || profile.model || `模型 ${index + 1}`).trim(),
			model: String(profile.model || "").trim(),
			requestJSON: String(profile.requestJSON || "").trim()
		};
	},

	makeSystemPromptID() {
		return `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	},

	normalizeSystemPrompt(prompt, index = 0) {
		if (!prompt || typeof prompt !== "object") return null;
		let id = String(prompt.id || `prompt-${index + 1}`).trim() || `prompt-${index + 1}`;
		let content = String(prompt.content || "").trim();
		return {
			id,
			name: String(prompt.name || `提示词 ${index + 1}`).trim() || `提示词 ${index + 1}`,
			content: content || this.DEFAULT_SYSTEM_PROMPT_CONTENT
		};
	},

	migrateLegacyLLMConfig(rawProviders = [], rawProfiles = []) {
		let providers = (rawProviders || []).map((provider, index) => this.normalizeLLMProvider(provider, index)).filter(Boolean);
		let profiles = [];
		let providersByLegacyKey = new Map();
		let getOrCreateProvider = (entry, index) => {
			if (String(entry.providerID || "").trim()) {
				let existing = providers.find((provider) => provider.id === entry.providerID);
				if (existing) return existing;
			}
			let apiBaseURL = String(entry.apiBaseURL || "").trim().replace(/\/+$/, "");
			let apiKey = String(entry.apiKey || "").trim().replace(/^Bearer\s+/i, "");
			let legacyKey = `${apiBaseURL}\n${apiKey}`;
			let existing = providersByLegacyKey.get(legacyKey);
			if (existing) return existing;
			let provider = this.normalizeLLMProvider({
				id: this.makeLLMProviderID(),
				name: this.inferProviderName(apiBaseURL, entry.providerName || entry.name || `供应商 ${providers.length + 1}`),
				apiBaseURL,
				apiKey,
				modelsPath: String(entry.modelsPath || "/models").trim() || "/models",
				chatPath: String(entry.chatPath || "/chat/completions").trim() || "/chat/completions"
			}, index);
			if (!provider) return null;
			providers.push(provider);
			providersByLegacyKey.set(legacyKey, provider);
			return provider;
		};
		let entries = Array.isArray(rawProfiles) ? rawProfiles : [];
		for (let [index, entry] of entries.entries()) {
			if (!entry || typeof entry !== "object") continue;
			let isNewShape = String(entry.providerID || "").trim() && !("apiBaseURL" in entry) && !("apiKey" in entry);
			if (isNewShape) {
				let normalized = this.normalizeLLMProfile(entry, profiles.length);
				if (normalized) profiles.push(normalized);
				continue;
			}
			let provider = getOrCreateProvider(entry, index);
			if (!provider) continue;
			let normalized = this.normalizeLLMProfile({
				id: String(entry.id || "").trim() || this.makeLLMModelID(),
				providerID: provider.id,
				name: String(entry.name || entry.model || `模型 ${profiles.length + 1}`).trim(),
				model: String(entry.model || "").trim(),
				requestJSON: String(entry.requestJSON || "").trim()
			}, profiles.length);
			if (normalized) profiles.push(normalized);
		}
		if (!providers.length || !profiles.length) {
			let legacy = this.getLegacyLLMSettings();
			let provider = this.normalizeLLMProvider({
				id: "default-provider",
				name: this.inferProviderName(legacy.apiBaseURL, "Default Provider"),
				apiBaseURL: legacy.apiBaseURL,
				apiKey: legacy.apiKey
			}, 0);
			let profile = this.normalizeLLMProfile({
				id: "default-model",
				providerID: provider.id,
				name: legacy.model || "Default Model",
				model: legacy.model,
				requestJSON: legacy.requestJSON
			}, 0);
			providers = [provider];
			profiles = [profile];
		}
		return { providers, profiles };
	},

	ensureLLMConfigStore() {
		let rawProviders = this.readJSONPrefArray("llmProvidersJSON");
		let rawProfiles = this.readJSONPrefArray("llmProfilesJSON");
		let providers = rawProviders.map((provider, index) => this.normalizeLLMProvider(provider, index)).filter(Boolean);
		let profiles = rawProfiles.map((profile, index) => this.normalizeLLMProfile(profile, index)).filter(Boolean);
		let providerIDs = new Set(providers.map((provider) => provider.id));
		let needsMigration = !providers.length
			|| !profiles.length
			|| rawProfiles.some((entry) => entry && typeof entry === "object" && (!String(entry.providerID || "").trim() || "apiBaseURL" in entry || "apiKey" in entry))
			|| profiles.some((profile) => !providerIDs.has(profile.providerID));
		if (needsMigration) {
			let migrated = this.migrateLegacyLLMConfig(rawProviders, rawProfiles);
			providers = migrated.providers;
			profiles = migrated.profiles;
			this.saveLLMProviders(providers);
			this.saveLLMProfiles(profiles);
		}
		let activeID = String(Zotero.Prefs.get(this.PREF_BRANCH + "activeLLMProfileID", true) || "").trim();
		if (!profiles.some((profile) => profile.id === activeID) && profiles[0]?.id) {
			this.setStringPref("activeLLMProfileID", profiles[0].id);
		}
		return { providers, profiles };
	},

	getLLMProviders() {
		return this.ensureLLMConfigStore().providers;
	},

	saveLLMProviders(providers) {
		let normalized = (providers || []).map((provider, index) => this.normalizeLLMProvider(provider, index)).filter(Boolean);
		Zotero.Prefs.set(this.PREF_BRANCH + "llmProvidersJSON", JSON.stringify(normalized, null, 2), true);
		return normalized;
	},

	saveLLMProfiles(profiles) {
		let normalized = (profiles || []).map((profile, index) => this.normalizeLLMProfile(profile, index)).filter(Boolean);
		Zotero.Prefs.set(this.PREF_BRANCH + "llmProfilesJSON", JSON.stringify(normalized, null, 2), true);
		return normalized;
	},

	ensureSystemPromptStore() {
		let rawPrompts = this.readJSONPrefArray("systemPromptsJSON");
		let prompts = rawPrompts.map((prompt, index) => this.normalizeSystemPrompt(prompt, index)).filter(Boolean);
		if (!prompts.length) {
			prompts = [this.normalizeSystemPrompt({
				id: "default-system-prompt",
				name: this.DEFAULT_SYSTEM_PROMPT_NAME,
				content: this.DEFAULT_SYSTEM_PROMPT_CONTENT
			}, 0)];
			this.saveSystemPromptProfiles(prompts);
		}
		let activeID = String(Zotero.Prefs.get(this.PREF_BRANCH + "activeSystemPromptID", true) || "").trim();
		if (!prompts.some((prompt) => prompt.id === activeID) && prompts[0]?.id) {
			this.setStringPref("activeSystemPromptID", prompts[0].id);
		}
		return prompts;
	},

	getSystemPromptProfiles() {
		return this.ensureSystemPromptStore();
	},

	saveSystemPromptProfiles(prompts) {
		let normalized = (prompts || []).map((prompt, index) => this.normalizeSystemPrompt(prompt, index)).filter(Boolean);
		if (!normalized.length) {
			normalized.push(this.normalizeSystemPrompt({
				id: "default-system-prompt",
				name: this.DEFAULT_SYSTEM_PROMPT_NAME,
				content: this.DEFAULT_SYSTEM_PROMPT_CONTENT
			}, 0));
		}
		Zotero.Prefs.set(this.PREF_BRANCH + "systemPromptsJSON", JSON.stringify(normalized, null, 2), true);
		return normalized;
	},

	getActiveSystemPromptID() {
		let activeID = String(Zotero.Prefs.get(this.PREF_BRANCH + "activeSystemPromptID", true) || "").trim();
		if (activeID) return activeID;
		let first = this.getSystemPromptProfiles()[0];
		if (first?.id) {
			this.setStringPref("activeSystemPromptID", first.id);
			return first.id;
		}
		return "";
	},

	getActiveSystemPrompt() {
		let prompts = this.getSystemPromptProfiles();
		let activeID = this.getActiveSystemPromptID();
		return prompts.find((prompt) => prompt.id === activeID) || prompts[0] || null;
	},

	setActiveSystemPromptID(promptID) {
		let prompts = this.getSystemPromptProfiles();
		let matched = prompts.find((prompt) => prompt.id === promptID) || prompts[0] || null;
		if (!matched) return false;
		this.setStringPref("activeSystemPromptID", matched.id);
		return true;
	},

	getActiveLLMProfileID() {
		let activeID = String(Zotero.Prefs.get(this.PREF_BRANCH + "activeLLMProfileID", true) || "").trim();
		if (activeID) return activeID;
		let first = this.getLLMProfiles()[0];
		if (first?.id) {
			this.setStringPref("activeLLMProfileID", first.id);
			return first.id;
		}
		return "";
	},

	getActiveLLMProfile() {
		let profiles = this.getLLMProfiles();
		let activeID = this.getActiveLLMProfileID();
		return profiles.find((profile) => profile.id === activeID) || profiles[0] || null;
	},

	setActiveLLMProfileID(profileID) {
		let profiles = this.getLLMProfiles();
		let matched = profiles.find((profile) => profile.id === profileID);
		if (!matched) return false;
		this.setStringPref("activeLLMProfileID", matched.id);
		return true;
	},

	parseOptionalJSONObject(rawValue, fieldLabel) {
		let normalized = String(rawValue || "").trim();
		if (!normalized) return {};
		let parsed;
		try {
			parsed = JSON.parse(normalized);
		}
		catch (e) {
			throw new Error(`${fieldLabel} 不是合法 JSON：${e.message || e}`);
		}
		if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
			throw new Error(`${fieldLabel} 必须是 JSON 对象`);
		}
		return parsed;
	},

	mergeRequestPayload(basePayload, extraPayload, reservedKeys = []) {
		let mergedPayload = { ...basePayload };
		for (let [key, value] of Object.entries(extraPayload || {})) {
			if (reservedKeys.includes(key)) {
				throw new Error(`额外 JSON 参数不能覆盖保留字段：${reservedKeys.join(", ")}`);
			}
			mergedPayload[key] = value;
		}
		return mergedPayload;
	},

	buildChatMessages(session) {
		let activePrompt = this.getActiveSystemPrompt();
		let messages = [{
			role: "system",
			content: String(activePrompt?.content || this.DEFAULT_SYSTEM_PROMPT_CONTENT).trim()
		}];
		for (let message of (session.messages || []).filter((entry) => !entry.error).slice(-this.MAX_HISTORY_MESSAGES)) {
			if (message.role === "assistant") {
				messages.push({ role: "assistant", content: message.content || "" });
				continue;
			}
			let content = String(message.content || "");
			let sourceBlock = this.buildSourceContextBlock(message.sourceRefs || []);
			if (sourceBlock) {
				content = `${sourceBlock}\n\nUser message:\n${content}`;
			}
			messages.push({ role: "user", content });
		}
		return messages;
	},

	buildSourceContextBlock(sourceRefs) {
		if (!sourceRefs.length) return "";
		let parts = ["Context sources:"];
		let total = 0;
		for (let [index, sourceRef] of sourceRefs.entries()) {
			let text = String(sourceRef.textSnapshot || "").trim();
			if (!text) continue;
			let remaining = this.CONTEXT_LIMIT_CHARS - total;
			if (remaining <= 0) break;
			let limit = Math.min(this.SOURCE_LIMIT_CHARS, remaining);
			if (text.length > limit) text = text.slice(0, limit) + "\n...[truncated]";
			total += text.length;
			parts.push(`[${index + 1}] ${sourceRef.label}\nkind=${sourceRef.resolutionKind}; parser=${sourceRef.parser}\n${text}`);
		}
		return parts.join("\n\n");
	},

	async requestMessagesCompletion({ llm, messages, onDelta, signal, onReader, allowStream = true }) {
		if (!llm?.apiBaseURL || !llm?.apiKey || !llm?.model) {
			throw new Error("请先在设置中填写供应商 API Base URL、API Key 和模型名");
		}
		let extraParams = this.parseOptionalJSONObject(llm.requestJSON, "额外 JSON 参数");
		let endpoint = this.resolveAPIEndpoint(llm.apiBaseURL, llm.chatPath || "/chat/completions");
		if (!allowStream) {
			return await this.requestChatCompletionNonStream({
				endpoint,
				apiKey: llm.apiKey,
				payload: this.mergeRequestPayload({ model: llm.model, messages, stream: false }, extraParams, ["model", "messages", "stream"]),
				signal,
				onDelta
			});
		}
		let sawStreamChunk = false;
		try {
			return await this.requestChatCompletionStream({
				endpoint,
				apiKey: llm.apiKey,
				payload: this.mergeRequestPayload({ model: llm.model, messages, stream: true }, extraParams, ["model", "messages", "stream"]),
				signal,
				onReader,
				onDelta: (chunk) => {
					sawStreamChunk = true;
					onDelta?.(chunk);
				}
			});
		}
		catch (streamError) {
			if (sawStreamChunk) throw streamError;
			return await this.requestChatCompletionNonStream({
				endpoint,
				apiKey: llm.apiKey,
				payload: this.mergeRequestPayload({ model: llm.model, messages, stream: false }, extraParams, ["model", "messages", "stream"]),
				signal,
				onDelta
			});
		}
	},

	async requestChatCompletion({ session, onDelta, signal, onReader }) {
		return await this.requestMessagesCompletion({
			llm: this.getLLMSettings(),
			messages: this.buildChatMessages(session),
			onDelta,
			signal,
			onReader,
			allowStream: true
		});
	},

	extractStreamDelta(parsed) {
		let delta = parsed?.choices?.[0]?.delta;
		if (!delta) return [];
		let chunks = [];
		let reasoning = delta.reasoning || delta.reasoning_content || delta.reasoningContent;
		let content = delta.content;
		let normalize = (value) => {
			if (typeof value === "string") return value;
			if (Array.isArray(value)) {
				return value.map((part) => typeof part === "string" ? part : (part?.text || part?.content || "")).join("");
			}
			return "";
		};
		let reasoningText = normalize(reasoning);
		let contentText = normalize(content);
		if (reasoningText) chunks.push({ type: "reasoning", text: reasoningText });
		if (contentText) chunks.push({ type: "content", text: contentText });
		return chunks;
	},

	async requestChatCompletionStream({ endpoint, apiKey, payload, onDelta, signal, onReader }) {
		let response = await fetch(endpoint, {
			method: "POST",
			headers: {
				"Accept": "text/event-stream, application/json",
				"Content-Type": "application/json",
				"Authorization": "Bearer " + apiKey
			},
			body: JSON.stringify(payload),
			signal
		});
		if (!response.ok) {
			let text = await response.text();
			throw new Error(`HTTP ${response.status}: ${text.slice(0, 1000)}`);
		}
		let contentType = String(response.headers.get("content-type") || "").toLowerCase();
		if (contentType.includes("application/json")) {
			let json = await response.json();
			let reasoning = json?.choices?.[0]?.message?.reasoning || json?.choices?.[0]?.message?.reasoning_content || json?.choices?.[0]?.message?.reasoningContent || "";
			let text = json?.choices?.[0]?.message?.content || "";
			if (reasoning) {
				onDelta?.({ type: "reasoning", text: String(reasoning) });
			}
			if (!text) throw new Error("模型返回为空");
			onDelta?.({ type: "content", text });
			return text;
		}
		let reader = response.body?.getReader?.();
		if (!reader) throw new Error("当前响应不支持流式读取");
		onReader?.(reader);
		let decoder = new TextDecoder("utf-8");
		let fullText = "";
		let pending = "";
		while (true) {
			if (signal?.aborted) {
				throw new DOMException("Aborted", "AbortError");
			}
			let { done, value } = await reader.read();
			if (done) break;
			pending += decoder.decode(value, { stream: true });
			let lines = pending.split(/\r?\n/);
			pending = lines.pop() || "";
			for (let rawLine of lines) {
				let line = rawLine.trim();
				if (!line.startsWith("data:")) continue;
				let payloadText = line.slice(5).trim();
				if (!payloadText || payloadText === "[DONE]") continue;
				let parsed;
				try { parsed = JSON.parse(payloadText); } catch (_e) { continue; }
				let chunks = this.extractStreamDelta(parsed);
				for (let chunk of chunks) {
					if (signal?.aborted) {
						throw new DOMException("Aborted", "AbortError");
					}
					if (chunk.type === "content") {
						fullText += chunk.text;
					}
					onDelta?.(chunk);
				}
			}
		}
		if (!fullText.trim()) throw new Error("模型未返回任何文本");
		return fullText;
	},

	async requestChatCompletionNonStream({ endpoint, apiKey, payload, onDelta, signal }) {
		let response = await fetch(endpoint, {
			method: "POST",
			headers: {
				"Accept": "application/json",
				"Content-Type": "application/json",
				"Authorization": "Bearer " + apiKey
			},
			body: JSON.stringify(payload),
			signal
		});
		let text = await response.text();
		if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 1000)}`);
		let json;
		try { json = JSON.parse(text); } catch (_e) { throw new Error("LLM 返回了无法解析的 JSON"); }
		let content = json?.choices?.[0]?.message?.content || "";
		let reasoning = json?.choices?.[0]?.message?.reasoning || json?.choices?.[0]?.message?.reasoning_content || "";
		if (reasoning) {
			onDelta?.({ type: "reasoning", text: String(reasoning) });
		}
		if (!content) throw new Error("模型返回为空");
		onDelta?.({ type: "content", text: content });
		return content;
	},

	async resolveContextSource(item, window) {
		if (!item) return { ok: false, reason: "缺少条目" };
		if (item.isNote?.()) {
			return await this.resolveNoteSource(item);
		}
		if (item.isAttachment?.()) {
			if (this.isImageAttachment(item)) {
				return { ok: false, reason: "图片附件暂不支持" };
			}
			if (this.isMarkdownAttachment(item)) {
				return await this.resolveMarkdownSource(item);
			}
			if (item.isPDFAttachment?.()) {
				return await this.resolvePDFAttachmentSource(item, window);
			}
			return { ok: false, reason: "当前仅支持 Markdown 或 PDF 附件" };
		}
		if (item.isRegularItem?.()) {
			return await this.resolveRegularItemSource(item, window);
		}
		return { ok: false, reason: "不支持的条目类型" };
	},

	isImageAttachment(item) {
		let contentType = String(item?.attachmentContentType || item?.getField?.("contentType") || "").toLowerCase();
		return contentType.startsWith("image/");
	},

	isMarkdownAttachment(item) {
		if (!item?.isAttachment?.()) return false;
		let contentType = String(item.attachmentContentType || item.getField?.("contentType") || "").toLowerCase();
		if (contentType === "text/markdown") return true;
		let title = String(item.getField?.("title") || "").trim();
		return /\.(md|markdown)$/i.test(title);
	},

	async resolveNoteSource(noteItem) {
		let rawHTML = noteItem.getNote?.() || "";
		let text = this.compactWhitespace(this.stripHTMLToPlainText(rawHTML));
		if (!text) return { ok: false, reason: "笔记没有可用文本" };
		let title = noteItem.getField?.("title") || this.firstTextLine(text) || "Note";
		return {
			ok: true,
			sourceRef: {
				sourceID: `${noteItem.libraryID}:${noteItem.key}:note`,
				libraryID: noteItem.libraryID,
				itemKey: noteItem.key,
				parentItemKey: noteItem.parentItem?.key || noteItem.parentKey || null,
				label: String(title).trim() || "Note",
				resolutionKind: "note",
				parser: "note-html",
				textSnapshot: this.limitText(text, this.SOURCE_LIMIT_CHARS),
				addedAt: new Date().toISOString()
			}
		};
	},

	async resolveMarkdownSource(attachment) {
		let path = await this.getAttachmentFilePath(attachment);
		if (!path) return { ok: false, reason: "Markdown 附件文件不存在" };
		let rawText = await IOUtils.readUTF8(path);
		let text = this.compactWhitespace(this.removeLocalImageReferences(rawText));
		if (!text) return { ok: false, reason: "Markdown 附件没有可用文本" };
		return {
			ok: true,
			sourceRef: {
				sourceID: `${attachment.libraryID}:${attachment.key}:markdown`,
				libraryID: attachment.libraryID,
				itemKey: attachment.key,
				parentItemKey: attachment.parentItem?.key || attachment.parentKey || null,
				label: this.getItemLabel(attachment),
				resolutionKind: "markdown-attachment",
				parser: "markdown-file",
				textSnapshot: this.limitText(text, this.SOURCE_LIMIT_CHARS),
				addedAt: new Date().toISOString()
			}
		};
	},

	async resolvePDFAttachmentSource(attachment, window) {
		let parentItem = attachment.parentItemID ? Zotero.Items.get(attachment.parentItemID) : null;
		let extracted = await this.extractPDFTextWithFallback(attachment, parentItem, window);
		if (!extracted?.text) return { ok: false, reason: "PDF 无法提取文本" };
		return {
			ok: true,
			sourceRef: {
				sourceID: `${attachment.libraryID}:${attachment.key}:pdf`,
				libraryID: attachment.libraryID,
				itemKey: attachment.key,
				parentItemKey: parentItem?.key || null,
				label: this.getItemLabel(parentItem || attachment),
				resolutionKind: "pdf-attachment",
				parser: extracted.parser,
				textSnapshot: this.limitText(extracted.text, this.SOURCE_LIMIT_CHARS),
				addedAt: new Date().toISOString()
			}
		};
	},

	async resolveRegularItemSource(item, window) {
		let mineruAttachment = this.findMineruMarkdownAttachment(item);
		if (mineruAttachment) {
			let markdownResult = await this.resolveMarkdownSource(mineruAttachment);
			if (markdownResult.ok) {
				markdownResult.sourceRef.sourceID = `${item.libraryID}:${item.key}:regular-markdown`;
				markdownResult.sourceRef.itemKey = item.key;
				markdownResult.sourceRef.parentItemKey = item.key;
				markdownResult.sourceRef.label = this.getItemLabel(item);
				markdownResult.sourceRef.resolutionKind = "regular-item-markdown";
				markdownResult.sourceRef.parser = "mineru-markdown";
				return markdownResult;
			}
		}

		let pdfAttachment = this.findFirstPDFAttachment(item);
		if (!pdfAttachment) {
			return { ok: false, reason: "该文献下没有可用 PDF 附件" };
		}
		let extracted = await this.extractPDFTextWithFallback(pdfAttachment, item, window);
		if (!extracted?.text) {
			return { ok: false, reason: "文献的 PDF 无法提取文本" };
		}
		return {
			ok: true,
			sourceRef: {
				sourceID: `${item.libraryID}:${item.key}:regular-pdf`,
				libraryID: item.libraryID,
				itemKey: item.key,
				parentItemKey: item.key,
				label: this.getItemLabel(item),
				resolutionKind: "regular-item-pdf",
				parser: extracted.parser,
				textSnapshot: this.limitText(extracted.text, this.SOURCE_LIMIT_CHARS),
				addedAt: new Date().toISOString()
			}
		};
	},

	findFirstPDFAttachment(parentItem) {
		if (!parentItem?.isRegularItem?.()) return null;
		let attachmentIDs = parentItem.getAttachments?.() || [];
		for (let attachmentID of attachmentIDs) {
			let attachment = Zotero.Items.get(attachmentID);
			if (attachment?.isPDFAttachment?.()) return attachment;
		}
		return null;
	},

	findMineruMarkdownAttachment(parentItem) {
		if (!parentItem?.isRegularItem?.()) return null;
		let attachmentIDs = parentItem.getAttachments?.() || [];
		for (let attachmentID of attachmentIDs) {
			let attachment = Zotero.Items.get(attachmentID);
			if (!attachment) continue;
			let tags = attachment.getTags?.() || [];
			let contentType = String(attachment.attachmentContentType || attachment.getField?.("contentType") || "").toLowerCase();
			let title = String(attachment.getField?.("title") || "").trim();
			if (tags.some((tag) => tag.tag === "#MinerU-Parse") && (contentType === "text/markdown" || /\.(md|markdown)$/i.test(title))) {
				return attachment;
			}
		}
		return null;
	},

	async extractPDFTextWithFallback(attachment, parentItem, window) {
		let mineru = this.getMineruRuntime(window);
		if (mineru) {
			let markdownAttachment = parentItem ? this.findMineruMarkdownAttachment(parentItem) : null;
			if (markdownAttachment) {
				let markdownResult = await this.resolveMarkdownSource(markdownAttachment);
				if (markdownResult.ok) {
					return {
						text: markdownResult.sourceRef.textSnapshot,
						parser: "mineru-markdown"
					};
				}
			}

			try {
				let settings = mineru.getSettings?.();
				if (settings?.apiToken && typeof mineru.parseAttachmentWithMineru === "function") {
					let parsed = await mineru.parseAttachmentWithMineru(attachment, settings, {});
					let rawText = parsed?.rawMarkdownText || parsed?.markdownText || "";
					if (rawText.trim()) {
						if (parentItem && typeof mineru.saveResultAsMarkdownAttachment === "function") {
							try {
								await mineru.saveResultAsMarkdownAttachment({
									attachment,
									parentItem,
									parsedResult: parsed,
									settings
								});
							}
							catch (saveError) {
								this.log(`Failed to save MinerU markdown attachment: ${saveError}`);
							}
						}
						return {
							text: this.compactWhitespace(this.removeLocalImageReferences(rawText)),
							parser: "mineru-live"
						};
					}
				}
			}
			catch (e) {
				this.log(`MinerU extraction failed, falling back to Zotero fulltext: ${e}`);
			}
		}

		let text = "";
		try {
			text = await attachment.attachmentText;
		}
		catch (_e) {}
		if (!String(text || "").trim() && Zotero.Fulltext?.indexItems) {
			try {
				await Zotero.Fulltext.indexItems([attachment.id]);
				text = await attachment.attachmentText;
			}
			catch (e) {
				this.log(`Zotero fulltext indexing failed: ${e}`);
			}
		}
		text = this.compactWhitespace(text);
		if (!text) return null;
		return { text, parser: "zotero-fulltext" };
	},

	getMineruRuntime(window) {
		return window?.ZoteroMineru || globalThis.ZoteroMineru || null;
	},

	stripHTMLToPlainText(html) {
		return String(html || "")
			.replace(/<script[\s\S]*?<\/script>/gi, " ")
			.replace(/<style[\s\S]*?<\/style>/gi, " ")
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<\/p>/gi, "\n")
			.replace(/<\/div>/gi, "\n")
			.replace(/<[^>]+>/g, " ")
			.replace(/&nbsp;/gi, " ")
			.replace(/&amp;/gi, "&")
			.replace(/&lt;/gi, "<")
			.replace(/&gt;/gi, ">")
			.replace(/&quot;/gi, "\"")
			.replace(/&#39;/gi, "'")
			.replace(/\r/g, "");
	},

	removeLocalImageReferences(markdownText) {
		let result = String(markdownText || "").replace(
			/!\[([^\]]*)\]\(([^)]+)\)/g,
			(match, _alt, url) => /^(https?:|\/\/|#|data:)/i.test(String(url).trim()) ? match : ""
		);
		result = result.replace(
			/<img\b([^>]*?)\bsrc=(["'])([^"']+)\2([^>]*)>/gi,
			(match, _before, _quote, src) => /^(https?:|\/\/|#|data:)/i.test(String(src).trim()) ? match : ""
		);
		return result.replace(/\n{3,}/g, "\n\n");
	},

	compactWhitespace(text) {
		return String(text || "")
			.replace(/\u00a0/g, " ")
			.replace(/[ \t]+\n/g, "\n")
			.replace(/\n{3,}/g, "\n\n")
			.replace(/[ \t]{2,}/g, " ")
			.trim();
	},

	limitText(text, limit) {
		let normalized = String(text || "").trim();
		if (normalized.length <= limit) return normalized;
		return normalized.slice(0, limit) + "\n...[truncated]";
	},

	firstTextLine(text) {
		return String(text || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
	},

	getItemLabel(item) {
		if (!item) return "Untitled";
		let title = item.getField?.("title") || "";
		if (String(title).trim()) return String(title).trim();
		if (item.isNote?.()) {
			let plain = this.compactWhitespace(this.stripHTMLToPlainText(item.getNote?.() || ""));
			return this.firstTextLine(plain) || "Note";
		}
		let filePath = item.getFilePath?.();
		if (typeof filePath === "string" && filePath) {
			return this.fileNameFromPath(filePath);
		}
		return item.itemType || "Untitled";
	},

	fileNameFromPath(path) {
		let normalized = String(path || "").replace(/\\/g, "/");
		let index = normalized.lastIndexOf("/");
		return index >= 0 ? normalized.slice(index + 1) : normalized;
	},

	async getAttachmentFilePath(attachment) {
		try {
			let path = attachment.getFilePath?.();
			if (path && typeof path.then === "function") {
				return await path;
			}
			return path || null;
		}
		catch (_e) {
			return null;
		}
	},

	async ensureChatCollection() {
		let libraryID = Zotero.Libraries.userLibraryID;
		let storedKey = (Zotero.Prefs.get(this.PREF_BRANCH + "chatCollectionKey", true) || "").trim();
		let existing = storedKey ? this.findCollectionByKey(libraryID, storedKey) : null;
		if (!existing) {
			existing = this.findCollectionByName(libraryID, this.COLLECTION_NAME);
		}
		if (existing) {
			this.setStringPref("chatCollectionKey", existing.key);
			return existing;
		}

		let collection = new Zotero.Collection();
		collection.libraryID = libraryID;
		collection.name = this.COLLECTION_NAME;
		await collection.saveTx();
		this.setStringPref("chatCollectionKey", collection.key);
		return collection;
	},

	async ensureConversationStore() {
		let collection = await this.ensureChatCollection();
		let libraryID = collection.libraryID;
		let storedKey = String(Zotero.Prefs.get(this.PREF_BRANCH + "chatStoreItemKey", true) || "").trim();
		let item = storedKey ? Zotero.Items.getByLibraryAndKey?.(libraryID, storedKey) : null;
		if (!item || item.deleted) {
			item = await this.findConversationStoreItem(collection);
		}
		if (!item) {
			item = new Zotero.Item("document");
			item.libraryID = libraryID;
			item.setField("title", this.STORE_ITEM_TITLE);
			if (typeof item.setCollections === "function") {
				item.setCollections([collection.id]);
			}
			item.addTag(this.CHAT_TAG, 0);
			await item.saveTx();
		}
		else {
			item.setField("title", this.STORE_ITEM_TITLE);
			item.addTag(this.CHAT_TAG, 0);
			await item.saveTx();
		}
		this.setStringPref("chatStoreItemKey", item.key);
		await this.migrateLegacySessionsToStore(collection, item);
		return { item };
	},

	async findConversationStoreItem(collection) {
		let search = new Zotero.Search();
		search.libraryID = collection.libraryID;
		search.addCondition("itemType", "is", "document");
		search.addCondition("tag", "is", this.CHAT_TAG);
		let ids = await search.search();
		for (let id of ids) {
			let item = Zotero.Items.get(id);
			if (!item || item.deleted) continue;
			let collections = item.getCollections?.() || [];
			if (collections.length && !collections.includes(collection.id)) continue;
			if (String(item.getField?.("title") || "").trim() === this.STORE_ITEM_TITLE) {
				return item;
			}
		}
		return null;
	},

	normalizeSessionData(data, index = 0) {
		if (!data || typeof data !== "object") return null;
		let normalized = { ...data };
		let number = Number(normalized.number);
		if (!Number.isFinite(number) || number < 1) {
			let fromID = String(normalized.sessionID || "").match(/(\d+)$/);
			number = fromID ? parseInt(fromID[1], 10) : (index + 1);
		}
		normalized.version = normalized.version || 1;
		if (Number.isFinite(number) && number > 0) {
			normalized.number = number;
		}
		else {
			delete normalized.number;
		}
		normalized.sessionID = String(normalized.sessionID || (Number.isFinite(number) && number > 0 ? `session-${number}` : this.makeSessionStorageKey(normalized.createdAt))).trim() || this.makeSessionStorageKey(normalized.createdAt);
		normalized.title = String(normalized.title || "").trim();
		normalized.createdAt = normalized.createdAt || new Date().toISOString();
		normalized.updatedAt = normalized.updatedAt || normalized.createdAt;
		normalized.sourceRefs = Array.isArray(normalized.sourceRefs) ? normalized.sourceRefs : [];
		normalized.messages = Array.isArray(normalized.messages) ? normalized.messages : [];
		return normalized;
	},

	async migrateLegacySessionsToStore(collection, storeItem) {
		let existingAttachments = await this.getSessionAttachments(storeItem);
		let existingSessionIDs = new Set();
		let nextNumber = 1;
		for (let attachment of existingAttachments) {
			let session = await this.loadSessionAttachment(storeItem, attachment);
			if (!session) continue;
			existingSessionIDs.add(session.data.sessionID);
			nextNumber = Math.max(nextNumber, (Number(session.data.number) || 0) + 1);
		}
		let aggregateAttachment = await this.getConversationAttachment(storeItem);
		if (aggregateAttachment) {
			let aggregateData = await this.loadLegacyAggregateStore(aggregateAttachment);
			for (let sessionData of aggregateData.sessions) {
				let normalized = this.normalizeSessionData({
					...sessionData,
					number: Number(sessionData.number) || nextNumber,
					title: String(sessionData.title || "").trim() || `会话 ${Number(sessionData.number) || nextNumber}`
				});
				if (!normalized || existingSessionIDs.has(normalized.sessionID)) continue;
				await this.createConversationAttachment(storeItem, normalized, this.getSessionFileName(normalized.number));
				existingSessionIDs.add(normalized.sessionID);
				nextNumber = Math.max(nextNumber, normalized.number + 1);
			}
		}
		let search = new Zotero.Search();
		search.libraryID = collection.libraryID;
		search.addCondition("itemType", "is", "document");
		search.addCondition("tag", "is", this.CHAT_TAG);
		let ids = await search.search();
		for (let id of ids) {
			let item = Zotero.Items.get(id);
			if (!item || item.deleted || item.id === storeItem.id) continue;
			let session = await this.loadLegacySession(item);
			if (!session) continue;
			if (existingSessionIDs.has(session.data.sessionID)) continue;
			let normalized = this.normalizeSessionData({
				...session.data,
				number: nextNumber,
				title: String(session.data.title || "").trim() || `会话 ${nextNumber}`
			});
			if (!normalized) continue;
			await this.createConversationAttachment(storeItem, normalized, this.getSessionFileName(normalized.number));
			existingSessionIDs.add(normalized.sessionID);
			nextNumber = Math.max(nextNumber, normalized.number + 1);
		}
	},

	findCollectionByKey(libraryID, key) {
		if (!key) return null;
		if (typeof Zotero.Collections?.getByLibraryAndKey === "function") {
			return Zotero.Collections.getByLibraryAndKey(libraryID, key);
		}
		let cache = Zotero.Collections?._objectCache || {};
		return Object.values(cache).find((entry) => entry?.libraryID === libraryID && entry?.key === key) || null;
	},

	findCollectionByName(libraryID, name) {
		let cache = Zotero.Collections?._objectCache || {};
		return Object.values(cache).find((entry) => (
			entry?.libraryID === libraryID
			&& !entry?.deleted
			&& !entry?.parentID
			&& entry?.name === name
		)) || null;
	},

	async getAllSessions() {
		let store = await this.ensureConversationStore();
		let attachments = await this.getSessionAttachments(store.item);
		let sessions = [];
		for (let attachment of attachments) {
			let session = await this.loadSessionAttachment(store.item, attachment);
			if (session) {
				session.store = store;
				sessions.push(session);
			}
		}
		sessions.sort((a, b) => String(b.data.updatedAt || "").localeCompare(String(a.data.updatedAt || "")));
		return sessions;
	},

	async createSession() {
		let store = await this.ensureConversationStore();
		let now = new Date().toISOString();
		let sessionKey = this.makeSessionStorageKey(now);
		let data = {
			version: 1,
			sessionID: sessionKey,
			title: "",
			createdAt: now,
			updatedAt: now,
			sourceRefs: [],
			messages: []
		};
		let attachment = await this.createConversationAttachment(store.item, data, this.getSessionFileName(sessionKey));
		return { store, item: store.item, attachment, data };
	},

	async getNextSessionNumber(storeItem) {
		let attachments = await this.getSessionAttachments(storeItem);
		let maxNumber = 0;
		for (let attachment of attachments) {
			let number = this.parseSessionNumberFromAttachment(attachment);
			if (number > maxNumber) maxNumber = number;
		}
		return maxNumber + 1;
	},

	getSessionFileName(number) {
		if (typeof number === "string") {
			return `${number}.json`;
		}
		return `${this.SESSION_FILE_PREFIX}${String(number).padStart(4, "0")}.json`;
	},

	parseSessionNumberFromAttachment(attachment) {
		let title = String(attachment?.getField?.("title") || "").trim();
		let match = title.match(/^session-(\d+)\.json$/i);
		return match ? parseInt(match[1], 10) : 0;
	},

	async getSessionAttachments(item) {
		let result = [];
		let attachmentIDs = item.getAttachments?.() || [];
		for (let attachmentID of attachmentIDs) {
			let attachment = Zotero.Items.get(attachmentID);
			if (!attachment) continue;
			let title = String(attachment.getField?.("title") || "").trim();
			let contentType = String(attachment.attachmentContentType || attachment.getField?.("contentType") || "").toLowerCase();
			if (contentType === "application/json" && (/^session-\d+\.json$/i.test(title) || /^[a-f0-9]{8}-\d{8}\.json$/i.test(title))) {
				result.push(attachment);
			}
		}
		result.sort((a, b) => String(b.getField?.("dateAdded") || "").localeCompare(String(a.getField?.("dateAdded") || "")));
		return result;
	},

	async loadSessionAttachment(storeItem, attachment) {
		let filePath = await this.getAttachmentFilePath(attachment);
		if (!filePath) return null;
		let rawText = await IOUtils.readUTF8(filePath).catch(() => "");
		if (!rawText) return null;
		try {
			let data = this.normalizeSessionData(JSON.parse(rawText));
			let number = this.parseSessionNumberFromAttachment(attachment);
			let attachmentKey = String(attachment.getField?.("title") || "").replace(/\.json$/i, "");
			if (!String(data.sessionID || "").trim()) {
				data.sessionID = attachmentKey;
			}
			if (number && (!Number.isFinite(Number(data.number)) || Number(data.number) < 1)) {
				data.number = number;
			}
			if (!String(data.title || "").trim()) {
				data.title = `会话 ${data.number || number || 1}`;
			}
			return { item: storeItem, attachment, data };
		}
		catch (e) {
			this.log(`Invalid session JSON for attachment ${attachment.id}: ${e}`);
			return null;
		}
	},

	async loadLegacyAggregateStore(attachment) {
		let filePath = await this.getAttachmentFilePath(attachment);
		if (!filePath) return { sessions: [] };
		let rawText = await IOUtils.readUTF8(filePath).catch(() => "");
		if (!rawText) return { sessions: [] };
		try {
			let parsed = JSON.parse(rawText);
			if (Array.isArray(parsed?.sessions)) {
				return { sessions: parsed.sessions.map((entry, index) => this.normalizeSessionData(entry, index)).filter(Boolean) };
			}
			let single = this.normalizeSessionData(parsed);
			return { sessions: single ? [single] : [] };
		}
		catch (_e) {
			return { sessions: [] };
		}
	},

	async loadLegacySession(item) {
		let attachment = await this.getConversationAttachment(item);
		if (!attachment) return null;
		let filePath = await this.getAttachmentFilePath(attachment);
		if (!filePath) return null;
		let rawText = await IOUtils.readUTF8(filePath).catch(() => "");
		if (!rawText) return null;
		let data;
		try {
			data = JSON.parse(rawText);
		}
		catch (e) {
			this.log(`Invalid conversation JSON for item ${item.id}: ${e}`);
			return null;
		}
		data = this.normalizeSessionData({
			...data,
			title: String(data.title || item.getField("title") || "").trim()
		});
		return { item, attachment, data };
	},

	async saveSession(session) {
		let store = session.store || await this.ensureConversationStore();
		session.data = this.normalizeSessionData(session.data);
		session.data.updatedAt = session.data.updatedAt || new Date().toISOString();
		session.item = store.item;
		if (!session.attachment) {
			let sessionKey = String(session.data.sessionID || "").trim() || this.makeSessionStorageKey(session.data.createdAt);
			session.data.sessionID = sessionKey;
			session.attachment = await this.createConversationAttachment(store.item, session.data, this.getSessionFileName(sessionKey));
		}
		else {
			let filePath = await this.getAttachmentFilePath(session.attachment);
			if (!filePath) {
				let sessionKey = String(session.data.sessionID || "").trim() || this.makeSessionStorageKey(session.data.createdAt);
				session.data.sessionID = sessionKey;
				session.attachment = await this.createConversationAttachment(store.item, session.data, this.getSessionFileName(sessionKey));
			}
			else {
				await IOUtils.writeUTF8(filePath, JSON.stringify(session.data, null, 2));
				await session.attachment.saveTx();
			}
		}
		session.store = store;
	},

	async deleteSessionAttachment(session) {
		let attachment = session?.attachment;
		if (!attachment) return;
		if (typeof attachment.eraseTx === "function") {
			await attachment.eraseTx();
			return;
		}
		if (typeof Zotero.Items?.eraseTx === "function") {
			await Zotero.Items.eraseTx([attachment.id]);
			return;
		}
		throw new Error("Unsupported Zotero deletion API");
	},

	async getConversationAttachment(item) {
		let attachmentIDs = item.getAttachments?.() || [];
		for (let attachmentID of attachmentIDs) {
			let attachment = Zotero.Items.get(attachmentID);
			if (!attachment) continue;
			let title = String(attachment.getField?.("title") || "").trim();
			if (title === this.CONVERSATION_FILE_NAME) {
				return attachment;
			}
		}
		return null;
	},

	async createConversationAttachment(parentItem, data, fileName = this.CONVERSATION_FILE_NAME) {
		let tempDir = PathUtils.join(
			PathUtils.tempDir,
			`zotero-copilot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
		);
		await IOUtils.makeDirectory(tempDir, { createAncestors: true });
		let tempPath = PathUtils.join(tempDir, fileName);
		await IOUtils.writeUTF8(tempPath, JSON.stringify(data, null, 2));
		try {
			let attachment = await Zotero.Attachments.importFromFile({
				file: tempPath,
				libraryID: parentItem.libraryID,
				parentItemID: parentItem.id,
				contentType: "application/json",
				charset: "utf-8"
			});
			attachment.setField?.("title", fileName);
			await attachment.saveTx();
			return attachment;
		}
		finally {
			await IOUtils.remove(tempPath).catch(() => {});
			await IOUtils.remove(tempDir, { recursive: true }).catch(() => {});
		}
	},

	makeID(prefix) {
		return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
	},

	makeSessionStorageKey(dateLike = null) {
		let datePart = this.formatSessionDate(dateLike);
		let hash = "";
		while (hash.length < 8) {
			hash += Math.random().toString(16).slice(2);
		}
		return `${hash.slice(0, 8)}-${datePart}`;
	},

	formatSessionDate(dateLike = null) {
		let date = dateLike ? new Date(dateLike) : new Date();
		if (Number.isNaN(date.getTime())) {
			date = new Date();
		}
		let year = String(date.getFullYear());
		let month = String(date.getMonth() + 1).padStart(2, "0");
		let day = String(date.getDate()).padStart(2, "0");
		return `${year}${month}${day}`;
	},

	setStringPref(name, value) {
		Zotero.Prefs.set(this.PREF_BRANCH + name, String(value || ""), true);
	},

	getBoolPref(name, defaultValue = false) {
		let value = Zotero.Prefs.get(this.PREF_BRANCH + name, true);
		if (value === undefined || value === null || value === "") {
			return !!defaultValue;
		}
		return !!value;
	},

	setBoolPref(name, value) {
		Zotero.Prefs.set(this.PREF_BRANCH + name, !!value, true);
	}
};
