globalThis.ZoteroCopilotMarkdownCore = {
	setRenderedHTML(el, html) {
		let doc = el.ownerDocument;
		let fragment = doc.createDocumentFragment();
		for (let node of this.parseHTMLToNodes(doc, html)) {
			fragment.appendChild(node);
		}
		if (this.shouldPreservePlainLineBreaks(fragment, html)) {
			throw new Error("Rendered HTML collapsed plain line breaks");
		}
		this.replaceNodeChildren(el, Array.from(fragment.childNodes || []));
	},

	shouldPreservePlainLineBreaks(fragment, html) {
		let source = String(html || "");
		if (!/<(p|ul|ol|li|blockquote|pre|h[1-6]|table|hr|br)\b/i.test(source)) {
			return false;
		}
		let textContent = Array.from(fragment.childNodes || []).map((node) => node.textContent || "").join("");
		return !!textContent && !/[\n\r]/.test(textContent) && /<(p|br|li|blockquote|pre|h[1-6])\b/i.test(source);
	},

	replaceNodeChildren(el, nodes) {
		while (el.firstChild) {
			el.removeChild(el.firstChild);
		}
		for (let node of nodes || []) {
			el.appendChild(node);
		}
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

	restoreFormulaPlaceholders(text, formulas = []) {
		return String(text || "")
			.replace(/@@MATHBLOCK(\d+)@@/g, (_match, index) => {
				let formula = formulas[parseInt(index, 10)];
				return formula ? `${formula.openDelimiter}${formula.expr}${formula.closeDelimiter}` : "";
			})
			.replace(/@@MATHINLINE(\d+)@@/g, (_match, index) => {
				let formula = formulas[parseInt(index, 10)];
				return formula ? `${formula.openDelimiter}${formula.expr}${formula.closeDelimiter}` : "";
			});
	},

	setMarkdownSourceAttribute(node, source, formulas = []) {
		if (!node || node.nodeType !== 1) return;
		let restored = this.restoreFormulaPlaceholders(source, formulas);
		if (restored) {
			node.setAttribute("data-md-source", restored);
		}
	},

	getFormulaPlaceholder(formulas = [], kind, index) {
		let formula = formulas[parseInt(index, 10)];
		if (!formula) return null;
		return {
			expr: formula.expr,
			openDelimiter: formula.openDelimiter,
			closeDelimiter: formula.closeDelimiter,
			displayMode: kind === "BLOCK" || !!formula.displayMode
		};
	},

	matchFormulaPlaceholderSource(source, formulas = []) {
		let match = String(source || "").trim().match(/^@@MATH(INLINE|BLOCK)(\d+)@@$/);
		if (!match) return null;
		return this.getFormulaPlaceholder(formulas, match[1], match[2]);
	},

	buildTextNodesWithFormulaPlaceholders(doc, text, formulas = []) {
		let source = String(text || "");
		let nodes = [];
		let lastIndex = 0;
		let pattern = /@@MATH(INLINE|BLOCK)(\d+)@@/g;
		for (let match of source.matchAll(pattern)) {
			if (match.index > lastIndex) {
				nodes.push(doc.createTextNode(source.slice(lastIndex, match.index)));
			}
			let formula = this.getFormulaPlaceholder(formulas, match[1], match[2]);
			if (formula) {
				nodes.push(this.buildFormulaNode(doc, formula.expr, formula.displayMode, formula.openDelimiter, formula.closeDelimiter));
			}
			else {
				nodes.push(doc.createTextNode(match[0]));
			}
			lastIndex = match.index + match[0].length;
		}
		if (lastIndex < source.length) {
			nodes.push(doc.createTextNode(source.slice(lastIndex)));
		}
		return this.mergeAdjacentTextNodes(doc, nodes);
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

	matchInlineParenFormula(source, startIndex) {
		if (!source.startsWith("\\(", startIndex)) return null;
		let end = source.indexOf("\\)", startIndex + 2);
		if (end === -1) return null;
		return { kind: "formula", start: startIndex, end: end + 2, content: source.slice(startIndex + 2, end), openDelimiter: "\\(", closeDelimiter: "\\)" };
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
				return { kind: "formula", start: startIndex, end: i + 1, content, openDelimiter: "$", closeDelimiter: "$" };
			}
		}
		return null;
	},

	mergeAdjacentTextNodes(doc, nodes) {
		let merged = [];
		for (let node of nodes || []) {
			if (!node) continue;
			let previous = merged[merged.length - 1] || null;
			if (node.nodeType === 3 && previous?.nodeType === 3) {
				previous.nodeValue = `${previous.nodeValue || ""}${node.nodeValue || ""}`;
				continue;
			}
			if (node.nodeType === 11) {
				for (let child of Array.from(node.childNodes || [])) {
					if (child?.ownerDocument !== doc) {
						child.ownerDocument = doc;
					}
					merged.push(child);
				}
				continue;
			}
			merged.push(node);
		}
		return merged;
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

	normalizeCopiedMarkdownLine(line) {
		let source = String(line || "");
		if (/ {2,}$/.test(source)) {
			return source;
		}
		return source.replace(/[ \t]+$/g, "");
	},

	normalizeCopiedMarkdown(text) {
		let source = String(text || "").replace(/\r\n?/g, "\n");
		let lines = source.split("\n").map((line) => this.normalizeCopiedMarkdownLine(line));
		return lines.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			.replace(/^[ \t]+|[ \t]+$/g, "")
			.replace(/^\n+|\n+$/g, "");
	},

	rangeIntersectsNode(range, node) {
		if (!range || !node) return false;
		let END_TO_START = range.END_TO_START ?? globalThis.Range?.END_TO_START ?? 3;
		let START_TO_END = range.START_TO_END ?? globalThis.Range?.START_TO_END ?? 1;
		try {
			let nodeRange = node.ownerDocument?.createRange?.();
			if (!nodeRange) return false;
			try {
				nodeRange.selectNode(node);
			}
			catch (_e) {
				nodeRange.selectNodeContents(node);
			}
			return range.compareBoundaryPoints(END_TO_START, nodeRange) < 0 && range.compareBoundaryPoints(START_TO_END, nodeRange) > 0;
		}
		catch (_e) {
			return false;
		}
	},

	isRangeFullySelectingNodeContents(range, node) {
		if (!range || !node) return false;
		let START_TO_START = range.START_TO_START ?? globalThis.Range?.START_TO_START ?? 0;
		let END_TO_END = range.END_TO_END ?? globalThis.Range?.END_TO_END ?? 2;
		try {
			let nodeRange = node.ownerDocument?.createRange?.();
			if (!nodeRange) return false;
			nodeRange.selectNodeContents(node);
			return range.compareBoundaryPoints(START_TO_START, nodeRange) <= 0 && range.compareBoundaryPoints(END_TO_END, nodeRange) >= 0;
		}
		catch (_e) {
			return false;
		}
	},

	isRangeFullySelectingNode(range, node) {
		if (!range || !node) return false;
		let START_TO_START = range.START_TO_START ?? globalThis.Range?.START_TO_START ?? 0;
		let END_TO_END = range.END_TO_END ?? globalThis.Range?.END_TO_END ?? 2;
		try {
			let nodeRange = node.ownerDocument?.createRange?.();
			if (!nodeRange) return false;
			nodeRange.selectNode(node);
			return range.compareBoundaryPoints(START_TO_START, nodeRange) <= 0 && range.compareBoundaryPoints(END_TO_END, nodeRange) >= 0;
		}
		catch (_e) {
			return false;
		}
	},

	getBoundaryElementNode(container) {
		if (!container) return null;
		if (container.nodeType === 1) return container;
		if (container.nodeType === 3) return container.parentElement || container.parentNode || null;
		return container.parentElement || container.parentNode || null;
	},

	getContainingFormulaNode(node) {
		let current = this.getBoundaryElementNode(node);
		while (current) {
			if (current.nodeType === 1 && current.getAttribute?.("data-md-formula")) {
				return this.getOutermostFormulaNode(current);
			}
			current = current.parentElement || current.parentNode || null;
		}
		return null;
	},

	isNodeWithin(node, ancestor) {
		if (!node || !ancestor) return false;
		let current = node.nodeType === 1 ? node : (node.parentElement || node.parentNode || null);
		while (current) {
			if (current === ancestor) return true;
			current = current.parentElement || current.parentNode || null;
		}
		return false;
	},

	buildCollapsedRangeFromBoundary(doc, container, offset = 0) {
		try {
			let collapsed = doc?.createRange?.();
			if (!collapsed || !container) return null;
			collapsed.setStart(container, offset);
			collapsed.setEnd(container, offset);
			return collapsed;
		}
		catch (_e) {
			return null;
		}
	},

	compareBoundaryPositions(doc, leftNode, leftOffset, rightNode, rightOffset) {
		if (leftNode === rightNode) {
			if (leftOffset < rightOffset) return -1;
			if (leftOffset > rightOffset) return 1;
			return 0;
		}
		try {
			let leftRange = this.buildCollapsedRangeFromBoundary(doc, leftNode, leftOffset);
			let rightRange = this.buildCollapsedRangeFromBoundary(doc, rightNode, rightOffset);
			if (!leftRange || !rightRange) return 0;
			let START_TO_START = leftRange.START_TO_START ?? globalThis.Range?.START_TO_START ?? 0;
			return leftRange.compareBoundaryPoints(START_TO_START, rightRange);
		}
		catch (_e) {
			return 0;
		}
	},

	getOrderedSelectionBoundaries(selection, fallbackRange = null) {
		let anchorNode = selection?.anchorNode || null;
		let focusNode = selection?.focusNode || null;
		if (!anchorNode || !focusNode) {
			return fallbackRange ? {
				startNode: fallbackRange.startContainer,
				startOffset: fallbackRange.startOffset,
				endNode: fallbackRange.endContainer,
				endOffset: fallbackRange.endOffset
			} : null;
		}
		let doc = anchorNode.ownerDocument || focusNode.ownerDocument || fallbackRange?.ownerDocument || null;
		let anchorOffset = selection?.anchorOffset ?? 0;
		let focusOffset = selection?.focusOffset ?? 0;
		let cmp = this.compareBoundaryPositions(doc, anchorNode, anchorOffset, focusNode, focusOffset);
		if (cmp <= 0) {
			return { startNode: anchorNode, startOffset: anchorOffset, endNode: focusNode, endOffset: focusOffset };
		}
		return { startNode: focusNode, startOffset: focusOffset, endNode: anchorNode, endOffset: anchorOffset };
	},

	getOutermostFormulaNode(node) {
		if (!node || node.nodeType !== 1 || !node.getAttribute?.("data-md-formula")) return null;
		let rawFormula = node.getAttribute("data-md-formula");
		let displayMode = String(node.getAttribute("data-md-formula-display") || "").toLowerCase();
		let current = node;
		let parent = current.parentElement;
		while (parent?.nodeType === 1 && parent.getAttribute?.("data-md-formula") === rawFormula) {
			let parentDisplayMode = String(parent.getAttribute("data-md-formula-display") || "").toLowerCase();
			if (parentDisplayMode !== displayMode) break;
			current = parent;
			parent = current.parentElement;
		}
		return current;
	},

	normalizeRangeForCopy(range, selection = null) {
		if (!range?.cloneRange) return range;
		let normalized = range.cloneRange();
		try {
			let boundaries = this.getOrderedSelectionBoundaries(selection, range);
			if (selection && boundaries?.startNode && boundaries?.endNode) {
				normalized.setStart(boundaries.startNode, boundaries.startOffset);
				normalized.setEnd(boundaries.endNode, boundaries.endOffset);
			}
			let startFormula = this.getContainingFormulaNode(normalized.startContainer);
			if (startFormula && this.rangeIntersectsNode(normalized, startFormula)) {
				normalized.setStartBefore(startFormula);
			}
			let endFormula = this.getContainingFormulaNode(normalized.endContainer);
			if (endFormula && this.rangeIntersectsNode(normalized, endFormula)) {
				normalized.setEndAfter(endFormula);
			}
		}
		catch (_e) {}
		return normalized;
	},

	getNodeMarkdownSource(node) {
		if (!node || node.nodeType !== 1) return "";
		return node.getAttribute?.("data-md-source") || node.getAttribute?.("data-md-block-source") || "";
	},

	getSelectedMarkdownNodeSource(node, range) {
		if (!node || !range || !this.rangeIntersectsNode(range, node)) return "";
		if (!this.isRangeFullySelectingNode(range, node) && !this.isRangeFullySelectingNodeContents(range, node)) {
			return "";
		}
		return this.getNodeMarkdownSource(node);
	},

	getSelectedTextFromNode(node, range) {
		if (!node || node.nodeType !== 3 || !this.rangeIntersectsNode(range, node)) return "";
		let value = node.nodeValue || "";
		let start = 0;
		let end = value.length;
		if (range.startContainer === node) {
			start = Math.max(0, Math.min(value.length, range.startOffset));
		}
		if (range.endContainer === node) {
			end = Math.max(0, Math.min(value.length, range.endOffset));
		}
		if (range.startContainer === node && range.endContainer === node) {
			start = Math.max(0, Math.min(value.length, Math.min(range.startOffset, range.endOffset)));
			end = Math.max(0, Math.min(value.length, Math.max(range.startOffset, range.endOffset)));
		}
		if (end <= start) return "";
		return value.slice(start, end);
	}
};
