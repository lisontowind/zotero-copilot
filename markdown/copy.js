globalThis.ZoteroCopilotMarkdownCopy = {
	getClipboardHelperService() {
		try {
			if (globalThis.Cc && globalThis.Ci?.nsIClipboardHelper) {
				return globalThis.Cc["@mozilla.org/widget/clipboardhelper;1"]?.getService(globalThis.Ci.nsIClipboardHelper) || null;
			}
		}
		catch (_e) {}
		try {
			let classes = globalThis.Components?.classes;
			let interfaces = globalThis.Components?.interfaces;
			if (classes && interfaces?.nsIClipboardHelper) {
				return classes["@mozilla.org/widget/clipboardhelper;1"]?.getService(interfaces.nsIClipboardHelper) || null;
			}
		}
		catch (_e) {}
		return null;
	},

	writeMarkdownToClipboard(markdown, event = null) {
		let text = String(markdown || "");
		if (!text) return false;
		let wrote = false;
		try {
			if (event?.clipboardData) {
				event.clipboardData.setData("text/plain", text);
				event.clipboardData.setData("text/markdown", text);
				wrote = true;
			}
		}
		catch (_e) {}
		if (wrote) return true;
		try {
			let helper = this.getClipboardHelperService();
			if (helper?.copyString) {
				helper.copyString(text);
				return true;
			}
		}
		catch (_e) {}
		try {
			if (globalThis.navigator?.clipboard?.writeText) {
				globalThis.navigator.clipboard.writeText(text);
				return true;
			}
		}
		catch (_e) {}
		return false;
	},

	isSerializedListItem(text, ordered = false) {
		let source = String(text || "").trimStart();
		return ordered ? /^\d+\.\s/.test(source) : /^[-*+]\s/.test(source);
	},

	serializeFragmentToMarkdown(fragment) {
		return this.normalizeCopiedMarkdown(Array.from(fragment.childNodes || []).map((node) => this.serializeMarkdownNode(node)).join(""));
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
			case "img": {
				let alt = node.getAttribute?.("alt") || "";
				let src = node.getAttribute?.("src") || "";
				return src ? `![${alt}](${src})` : alt;
			}
			case "input":
				return String(node.getAttribute?.("type") || "").toLowerCase() === "checkbox"
					? (node.getAttribute?.("checked") != null ? "[x]" : "[ ]")
					: "";
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
				return `${Array.from(node.children || []).map((child) => {
					let serialized = this.normalizeCopiedMarkdown(this.serializeMarkdownNode(child));
					if (!serialized) return "";
					return this.isSerializedListItem(serialized, false) ? serialized : `- ${serialized.replace(/\n/g, "\n  ")}`;
				}).filter(Boolean).join("\n")}\n\n`;
			case "ol":
				return `${Array.from(node.children || []).map((child, index) => {
					let serialized = this.normalizeCopiedMarkdown(this.serializeMarkdownNode(child));
					if (!serialized) return "";
					return this.isSerializedListItem(serialized, true) ? serialized : `${index + 1}. ${serialized.replace(/\n/g, "\n   ")}`;
				}).filter(Boolean).join("\n")}\n\n`;
			case "li":
				return this.normalizeCopiedMarkdown(children);
			case "hr":
				return "\n---\n\n";
			case "summary":
				return "";
			default:
				return children;
		}
	},

	getIntersectingMarkdownRoots(state, range) {
		if (!state?.messages || !range) return [];
		return Array.from(state.messages.querySelectorAll?.(".zc-markdown") || []).filter((root) => this.rangeIntersectsNode(range, root));
	},

	getSelectedMarkdownRootSource(root) {
		return this.normalizeCopiedMarkdown(root?.dataset?.markdownSource || "");
	},

	serializeSelectedMarkdownChildren(node, range) {
		return Array.from(node?.childNodes || []).map((child) => this.serializeSelectedMarkdownNode(child, range)).join("");
	},

	serializeSelectedMarkdownNode(node, range, assumeIntersecting = false) {
		if (!node || (!assumeIntersecting && !this.rangeIntersectsNode(range, node))) return "";
		if (node.nodeType === 3) {
			return this.getSelectedTextFromNode(node, range);
		}
		if (node.nodeType === 11) {
			return this.serializeSelectedMarkdownChildren(node, range);
		}
		if (node.nodeType !== 1) {
			return "";
		}
		let formulaNode = this.getOutermostFormulaNode(node);
		if (formulaNode) {
			return formulaNode === node ? this.getSerializedFormulaSource(formulaNode) : "";
		}
		let source = this.getSelectedMarkdownNodeSource(node, range);
		if (source) {
			return source;
		}
		let tag = String(node.nodeName || "").toLowerCase();
		let children = this.serializeSelectedMarkdownChildren(node, range);
		switch (tag) {
			case "br":
				return "\n";
			case "strong":
			case "b":
				return children ? `**${children}**` : "";
			case "em":
			case "i":
				return children ? `*${children}*` : "";
			case "del":
			case "s":
				return children ? `~~${children}~~` : "";
			case "code":
				if (String(node.parentNode?.nodeName || "").toLowerCase() === "pre") {
					return children;
				}
				return children ? `\`${children}\`` : "";
			case "a": {
				let href = node.getAttribute?.("href") || "";
				if (!children) return "";
				return href ? `[${children}](${href})` : children;
			}
			case "img": {
				let alt = node.getAttribute?.("alt") || "";
				let src = node.getAttribute?.("src") || "";
				return src ? `![${alt}](${src})` : alt;
			}
			case "input":
				return String(node.getAttribute?.("type") || "").toLowerCase() === "checkbox"
					? (node.getAttribute?.("checked") != null ? "[x]" : "[ ]")
					: "";
			case "p":
				return children ? `${children}\n\n` : "";
			case "h1":
			case "h2":
			case "h3":
			case "h4":
			case "h5":
			case "h6":
				return children ? `${"#".repeat(parseInt(tag.slice(1), 10))} ${children}\n\n` : "";
			case "blockquote": {
				if (!children) return "";
				let quote = this.normalizeCopiedMarkdown(children).split("\n").map((line) => line ? `> ${line}` : ">").join("\n");
				return `${quote}\n\n`;
			}
			case "ul":
				return `${Array.from(node.children || []).map((child) => this.normalizeCopiedMarkdown(this.serializeSelectedMarkdownNode(child, range))).filter(Boolean).map((child) => this.isSerializedListItem(child, false) ? child : `- ${child.replace(/\n/g, "\n  ")}`).join("\n")}\n\n`;
			case "ol":
				return `${Array.from(node.children || []).map((child, index) => ({ index, text: this.normalizeCopiedMarkdown(this.serializeSelectedMarkdownNode(child, range)) })).filter((entry) => entry.text).map((entry) => this.isSerializedListItem(entry.text, true) ? entry.text : `${entry.index + 1}. ${entry.text.replace(/\n/g, "\n   ")}`).join("\n")}\n\n`;
			case "li":
				return this.normalizeCopiedMarkdown(children);
			case "pre":
				return children || node.textContent || "";
			case "hr":
				return "\n---\n\n";
			case "summary":
				return "";
			default:
				return children;
		}
	},

	serializeSelectedMarkdownRoot(root, range, selection = null) {
		if (!root || !range || !this.rangeIntersectsNode(range, root)) return "";
		if (this.isRangeFullySelectingNodeContents(range, root)) {
			let source = this.getSelectedMarkdownRootSource(root);
			if (source) return source;
		}
		return this.normalizeCopiedMarkdown(this.serializeSelectedMarkdownChildren(root, range));
	},

	serializeMarkdownSelection(state, range, selection = null) {
		let roots = this.getIntersectingMarkdownRoots(state, range);
		if (!roots.length) return "";
		let parts = [];
		for (let root of roots) {
			let serialized = this.serializeSelectedMarkdownRoot(root, range, selection);
			if (serialized) {
				parts.push(serialized);
			}
		}
		return this.normalizeCopiedMarkdown(parts.join("\n\n"));
	},

	handleMessagesCopy(state, event) {
		if (event?.defaultPrevented) return;
		let selection = state.doc.defaultView?.getSelection?.() || state.doc.getSelection?.();
		if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
		let anchorRoot = selection.anchorNode?.nodeType === 1 ? selection.anchorNode : selection.anchorNode?.parentElement;
		let focusRoot = selection.focusNode?.nodeType === 1 ? selection.focusNode : selection.focusNode?.parentElement;
		if (!anchorRoot?.closest?.(".zc-markdown") && !focusRoot?.closest?.(".zc-markdown")) return;
		let range = this.normalizeRangeForCopy(selection.getRangeAt(0));
		let roots = this.getIntersectingMarkdownRoots(state, range);
		let markdown = "";
		let shouldPreferRootSerialization = roots.length > 1
			|| roots.some((root) => this.isRangeFullySelectingNodeContents(range, root));
		if (shouldPreferRootSerialization) {
			markdown = this.serializeMarkdownSelection(state, range, selection);
		}
		if (!markdown) {
			let fragment = range.cloneContents();
			markdown = this.normalizeCopiedMarkdown(this.serializeFragmentToMarkdown(fragment));
		}
		if (!markdown) {
			markdown = this.serializeMarkdownSelection(state, range, selection);
		}
		if (!markdown) return;
		let wrote = this.writeMarkdownToClipboard(markdown, event);
		if (wrote) {
			event?.preventDefault?.();
		}
	}
};
