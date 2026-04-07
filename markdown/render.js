globalThis.ZoteroCopilotMarkdownRender = {
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
			this.replaceNodeChildren(el, nodes);
		}
		catch (e) {
			Zotero.logError?.(e);
			this.log(`Markdown render fallback: ${e?.message || e}`);
			el.classList.add("zc-markdown-fallback");
			this.replaceNodeChildren(el, [el.ownerDocument.createTextNode(source)]);
		}
	},

	buildMarkdownNodes(doc, markdownText, formulas = null) {
		let normalizedText = this.sanitizeDOMString(markdownText).replace(/\r\n?/g, "\n");
		let tokenized = Array.isArray(formulas) ? { text: normalizedText, formulas } : this.tokenizeFormulaPlaceholders(normalizedText);
		let tokens = this.repairMarkdownTokenTree(this.lexMarkdownTokens(tokenized.text));
		return this.renderMarkdownTokens(doc, tokens, tokenized.formulas);
	},

	lexMarkdownTokens(markdownText) {
		let marked = this.getMarkedRenderer();
		let source = String(markdownText || "");
		let options = { async: false, gfm: true, breaks: false };
		if (typeof marked?.lexer === "function") {
			return marked.lexer(source, options);
		}
		if (typeof marked?.Lexer?.lex === "function") {
			return marked.Lexer.lex(source, options);
		}
		throw new Error("Marked lexer unavailable");
	},

	repairMarkdownTokenTree(tokens) {
		let repaired = [];
		for (let token of tokens || []) {
			for (let nextToken of this.repairMarkdownToken(token)) {
				repaired.push(nextToken);
			}
		}
		return repaired;
	},

	repairMarkdownToken(token) {
		if (!token || typeof token !== "object") return token ? [token] : [];
		let repaired = { ...token };
		if (Array.isArray(token.tokens)) {
			repaired.tokens = this.tokenHasInlineChildren(token) ? this.repairInlineTokenArray(token.tokens) : this.repairMarkdownTokenTree(token.tokens);
		}
		if (Array.isArray(token.items)) {
			repaired.items = token.items.map((item) => {
				let nextItem = { ...item };
				if (Array.isArray(item?.tokens)) {
					nextItem.tokens = this.repairMarkdownTokenTree(item.tokens);
				}
				return nextItem;
			});
		}
		if (Array.isArray(token.header)) {
			repaired.header = token.header.map((cell) => this.repairMarkdownTableCellToken(cell));
		}
		if (Array.isArray(token.rows)) {
			repaired.rows = token.rows.map((row) => Array.from(row || []).map((cell) => this.repairMarkdownTableCellToken(cell)));
		}
		return [repaired];
	},

	repairMarkdownTableCellToken(cell) {
		if (!cell || typeof cell !== "object") return cell;
		let repaired = { ...cell };
		if (Array.isArray(cell.tokens)) {
			repaired.tokens = this.repairInlineTokenArray(cell.tokens);
		}
		return repaired;
	},

	tokenHasInlineChildren(token) {
		let type = String(token?.type || "").toLowerCase();
		return ["paragraph", "text", "heading", "strong", "em", "del", "link"].includes(type);
	},

	repairInlineTokenArray(tokens) {
		let repaired = [];
		for (let token of tokens || []) {
			for (let nextToken of this.repairInlineToken(token)) {
				repaired.push(nextToken);
			}
		}
		return repaired;
	},

	repairInlineToken(token) {
		if (!token || typeof token !== "object") return token ? [token] : [];
		let repaired = { ...token };
		if (Array.isArray(token.tokens)) {
			repaired.tokens = this.repairInlineTokenArray(token.tokens);
		}
		if (token.type === "text" && !Array.isArray(token.tokens) && typeof token.text === "string") {
			return this.repairLooseStrongTextToken(repaired);
		}
		return [repaired];
	},

	repairLooseStrongTextToken(token) {
		let text = String(token?.text || "");
		if (!text || (!text.includes("**") && !text.includes("__"))) {
			return [token];
		}
		let tokens = [];
		let cursor = 0;
		while (cursor < text.length) {
			let match = this.findNextLooseStrongToken(text, cursor);
			if (!match) {
				let tail = text.slice(cursor);
				if (tail) {
					tokens.push({ type: "text", raw: tail, text: tail, escaped: false });
				}
				break;
			}
			if (match.start > cursor) {
				let leading = text.slice(cursor, match.start);
				tokens.push({ type: "text", raw: leading, text: leading, escaped: false });
			}
			let innerText = match.content;
			tokens.push({
				type: "strong",
				raw: match.raw,
				text: innerText,
				tokens: this.repairInlineTokenArray([{ type: "text", raw: innerText, text: innerText, escaped: false }])
			});
			cursor = match.end;
		}
		return tokens.length ? tokens : [token];
	},

	findNextLooseStrongToken(text, startIndex = 0) {
		let source = String(text || "");
		for (let i = Math.max(0, startIndex); i < source.length - 3; i++) {
			let delimiter = source.slice(i, i + 2);
			if ((delimiter !== "**" && delimiter !== "__") || source[i - 1] === "\\" || source[i + 2] === delimiter[0]) {
				continue;
			}
			for (let j = i + 2; j < source.length - 1; j++) {
				if (source[j] === "\\") {
					j += 1;
					continue;
				}
				if (source.slice(j, j + 2) !== delimiter || source[j + 2] === delimiter[0]) {
					continue;
				}
				let content = source.slice(i + 2, j);
				if (!content || content.includes("\n")) break;
				return { start: i, end: j + 2, raw: source.slice(i, j + 2), content };
			}
		}
		return null;
	},

	renderMarkdownTokens(doc, tokens, formulas = []) {
		let nodes = [];
		for (let token of tokens || []) {
			for (let node of this.renderMarkdownToken(doc, token, formulas)) {
				nodes.push(node);
			}
		}
		return nodes;
	},

	renderMarkdownToken(doc, token, formulas = []) {
		if (!token) return [];
		let raw = String(token.raw || "");
		let formulaMatch = this.matchFormulaPlaceholderSource(raw, formulas);
		if (formulaMatch?.displayMode) {
			return [this.buildFormulaNode(doc, formulaMatch.expr, true, formulaMatch.openDelimiter, formulaMatch.closeDelimiter)];
		}
		switch (token.type) {
			case "space":
				return [];
			case "paragraph":
			case "text": {
				let p = doc.createElementNS(this.HTML_NS, "p");
				for (let child of this.renderInlineMarkdownTokens(doc, token.tokens || [], formulas, token.text || raw)) {
					p.appendChild(child);
				}
				this.setMarkdownSourceAttribute(p, raw, formulas);
				return [p];
			}
			case "heading": {
				let level = Math.max(1, Math.min(6, parseInt(token.depth || 1, 10) || 1));
				let heading = doc.createElementNS(this.HTML_NS, `h${level}`);
				for (let child of this.renderInlineMarkdownTokens(doc, token.tokens || [], formulas, token.text || raw)) {
					heading.appendChild(child);
				}
				this.setMarkdownSourceAttribute(heading, raw, formulas);
				return [heading];
			}
			case "code": {
				let pre = doc.createElementNS(this.HTML_NS, "pre");
				let code = doc.createElementNS(this.HTML_NS, "code");
				if (token.lang) code.setAttribute("data-language", String(token.lang).trim());
				code.textContent = token.text || "";
				pre.appendChild(code);
				this.setMarkdownSourceAttribute(pre, raw, formulas);
				return [pre];
			}
			case "blockquote": {
				let blockquote = doc.createElementNS(this.HTML_NS, "blockquote");
				for (let child of this.renderMarkdownTokens(doc, token.tokens || [], formulas)) {
					blockquote.appendChild(child);
				}
				this.setMarkdownSourceAttribute(blockquote, raw, formulas);
				return [blockquote];
			}
			case "list": {
				let list = doc.createElementNS(this.HTML_NS, token.ordered ? "ol" : "ul");
				if (token.ordered && token.start && token.start !== 1) {
					list.setAttribute("start", String(token.start));
				}
				for (let item of token.items || []) {
					list.appendChild(this.renderMarkdownListItem(doc, item, formulas));
				}
				this.setMarkdownSourceAttribute(list, raw, formulas);
				return [list];
			}
			case "hr": {
				let hr = doc.createElementNS(this.HTML_NS, "hr");
				this.setMarkdownSourceAttribute(hr, raw, formulas);
				return [hr];
			}
			case "table":
				return [this.renderMarkdownTable(doc, token, formulas)];
			case "html": {
				let fallback = doc.createElementNS(this.HTML_NS, "p");
				fallback.textContent = token.text || raw;
				this.setMarkdownSourceAttribute(fallback, raw, formulas);
				return [fallback];
			}
			default: {
				if (Array.isArray(token.tokens) && token.tokens.length) {
					let wrapper = doc.createElementNS(this.HTML_NS, "div");
					for (let child of this.renderMarkdownTokens(doc, token.tokens, formulas)) {
						wrapper.appendChild(child);
					}
					this.setMarkdownSourceAttribute(wrapper, raw, formulas);
					return [wrapper];
				}
				if (token.text || raw) {
					let p = doc.createElementNS(this.HTML_NS, "p");
					for (let child of this.buildTextNodesWithFormulaPlaceholders(doc, token.text || raw, formulas)) {
						p.appendChild(child);
					}
					this.setMarkdownSourceAttribute(p, raw || token.text, formulas);
					return [p];
				}
				return [];
			}
		}
	},

	renderMarkdownListItem(doc, item, formulas = []) {
		let li = doc.createElementNS(this.HTML_NS, "li");
		if (item?.task) {
			let checkbox = doc.createElementNS(this.HTML_NS, "input");
			checkbox.setAttribute("type", "checkbox");
			checkbox.setAttribute("disabled", "disabled");
			if (item.checked) checkbox.setAttribute("checked", "checked");
			li.appendChild(checkbox);
			li.appendChild(doc.createTextNode(" "));
		}
		let childTokens = item?.tokens || [];
		if (childTokens.length) {
			for (let child of this.renderMarkdownTokens(doc, childTokens, formulas)) {
				li.appendChild(child);
			}
		}
		else if (item?.text) {
			for (let child of this.buildTextNodesWithFormulaPlaceholders(doc, item.text, formulas)) {
				li.appendChild(child);
			}
		}
		this.setMarkdownSourceAttribute(li, item?.raw || "", formulas);
		return li;
	},

	renderMarkdownTable(doc, token, formulas = []) {
		let table = doc.createElementNS(this.HTML_NS, "table");
		let thead = doc.createElementNS(this.HTML_NS, "thead");
		let tbody = doc.createElementNS(this.HTML_NS, "tbody");
		let headerRow = doc.createElementNS(this.HTML_NS, "tr");
		for (let [index, cell] of Array.from(token.header || []).entries()) {
			headerRow.appendChild(this.renderMarkdownTableCell(doc, "th", cell, token.align?.[index], formulas));
		}
		thead.appendChild(headerRow);
		table.appendChild(thead);
		for (let row of token.rows || []) {
			let tr = doc.createElementNS(this.HTML_NS, "tr");
			for (let [index, cell] of Array.from(row || []).entries()) {
				tr.appendChild(this.renderMarkdownTableCell(doc, "td", cell, token.align?.[index], formulas));
			}
			tbody.appendChild(tr);
		}
		table.appendChild(tbody);
		this.setMarkdownSourceAttribute(table, token.raw || "", formulas);
		return table;
	},

	renderMarkdownTableCell(doc, tag, cell, align, formulas = []) {
		let el = doc.createElementNS(this.HTML_NS, tag);
		if (align) el.setAttribute("align", align);
		let tokens = cell?.tokens || [];
		if (tokens.length) {
			for (let child of this.renderInlineMarkdownTokens(doc, tokens, formulas, cell?.text || "")) {
				el.appendChild(child);
			}
		}
		else {
			for (let child of this.buildTextNodesWithFormulaPlaceholders(doc, cell?.text || "", formulas)) {
				el.appendChild(child);
			}
		}
		return el;
	},

	renderInlineMarkdownTokens(doc, tokens, formulas = [], fallbackText = "") {
		if ((!tokens || !tokens.length) && fallbackText) {
			return this.buildTextNodesWithFormulaPlaceholders(doc, fallbackText, formulas);
		}
		let nodes = [];
		for (let token of tokens || []) {
			for (let node of this.renderInlineMarkdownToken(doc, token, formulas)) {
				nodes.push(node);
			}
		}
		return this.mergeAdjacentTextNodes(doc, nodes);
	},

	renderInlineMarkdownToken(doc, token, formulas = []) {
		if (!token) return [];
		let raw = String(token.raw || "");
		let text = "text" in token ? String(token.text || "") : raw;
		let formulaMatch = this.matchFormulaPlaceholderSource(text || raw, formulas);
		if (formulaMatch && !formulaMatch.displayMode) {
			return [this.buildFormulaNode(doc, formulaMatch.expr, false, formulaMatch.openDelimiter, formulaMatch.closeDelimiter)];
		}
		switch (token.type) {
			case "text":
				if (Array.isArray(token.tokens) && token.tokens.length) {
					return this.renderInlineMarkdownTokens(doc, token.tokens, formulas, token.text || "");
				}
				return this.buildTextNodesWithFormulaPlaceholders(doc, text, formulas);
			case "escape":
				return this.buildTextNodesWithFormulaPlaceholders(doc, text, formulas);
			case "codespan": {
				let code = doc.createElementNS(this.HTML_NS, "code");
				code.textContent = token.text || "";
				this.setMarkdownSourceAttribute(code, raw, formulas);
				return [code];
			}
			case "strong":
			case "em":
			case "del": {
				let tag = token.type === "strong" ? "strong" : token.type;
				let el = doc.createElementNS(this.HTML_NS, tag);
				for (let child of this.renderInlineMarkdownTokens(doc, token.tokens || [], formulas, token.text || "")) {
					el.appendChild(child);
				}
				this.setMarkdownSourceAttribute(el, raw, formulas);
				return [el];
			}
			case "link": {
				let a = doc.createElementNS(this.HTML_NS, "a");
				let href = this.sanitizeURL(token.href || "");
				if (href) a.setAttribute("href", href);
				if (token.title) a.setAttribute("title", token.title);
				for (let child of this.renderInlineMarkdownTokens(doc, token.tokens || [], formulas, token.text || token.href || "")) {
					a.appendChild(child);
				}
				this.setMarkdownSourceAttribute(a, raw, formulas);
				return [a];
			}
			case "image": {
				let img = doc.createElementNS(this.HTML_NS, "img");
				let src = this.sanitizeURL(token.href || "");
				if (src) img.setAttribute("src", src);
				img.setAttribute("alt", token.text || "");
				if (token.title) img.setAttribute("title", token.title);
				this.setMarkdownSourceAttribute(img, raw, formulas);
				return [img];
			}
			case "br": {
				let br = doc.createElementNS(this.HTML_NS, "br");
				this.setMarkdownSourceAttribute(br, raw || "  \n", formulas);
				return [br];
			}
			case "html":
				return [doc.createTextNode(token.text || raw)];
			default:
				if (Array.isArray(token.tokens) && token.tokens.length) {
					return this.renderInlineMarkdownTokens(doc, token.tokens, formulas, token.text || "");
				}
				return this.buildTextNodesWithFormulaPlaceholders(doc, text || raw, formulas);
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

	renderFormulaHTML(expr, displayMode, openDelimiter, closeDelimiter, katexOverride = null) {
		let safeExpr = this.sanitizeDOMString(expr);
		let source = `${openDelimiter}${safeExpr}${closeDelimiter}`;
		let katex = katexOverride || this.getKatexRenderer();
		let tag = displayMode ? "div" : "span";
		let className = displayMode ? "zc-formula zc-formula-block" : "zc-formula zc-formula-inline";
		let fallbackClass = `${className} zc-formula-fallback`;
		let dataAttr = this.escapeHTML(source);
		if (katex?.renderToString && String(safeExpr || "").trim()) {
			try {
				let rendered = katex.renderToString(safeExpr, {
					displayMode: !!displayMode,
					throwOnError: false,
					output: "htmlAndMathml",
					trust: false,
					strict: "ignore"
				});
				return `<${tag} class="${className}" data-md-formula="${dataAttr}" data-md-formula-status="katex-rendered">${rendered}</${tag}>`;
			}
			catch (e) {
				Zotero.logError?.(e);
				this.log(`Formula HTML render fallback: ${e?.message || e}`);
			}
		}
		return `<${tag} class="${fallbackClass}" data-md-formula="${dataAttr}" data-md-formula-status="katex-missing">${this.escapeHTML(source)}</${tag}>`;
	}
};
