#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

class FakeNode {
	constructor(nodeType, ownerDocument) {
		this.nodeType = nodeType;
		this.ownerDocument = ownerDocument;
		this.parentNode = null;
		this.childNodes = [];
	}

	get parentElement() {
		return this.parentNode?.nodeType === 1 ? this.parentNode : null;
	}

	get firstChild() {
		return this.childNodes[0] || null;
	}

	get children() {
		return this.childNodes.filter((child) => child.nodeType === 1);
	}

	appendChild(node) {
		if (!node) return null;
		if (node.parentNode) {
			node.parentNode.removeChild(node);
		}
		node.parentNode = this;
		node.ownerDocument = this.ownerDocument;
		this.childNodes.push(node);
		return node;
	}

	removeChild(node) {
		let index = this.childNodes.indexOf(node);
		if (index >= 0) {
			this.childNodes.splice(index, 1);
			node.parentNode = null;
		}
		return node;
	}

	insertBefore(node, referenceNode) {
		if (!referenceNode) return this.appendChild(node);
		let index = this.childNodes.indexOf(referenceNode);
		if (index === -1) return this.appendChild(node);
		if (node.parentNode) {
			node.parentNode.removeChild(node);
		}
		node.parentNode = this;
		node.ownerDocument = this.ownerDocument;
		this.childNodes.splice(index, 0, node);
		return node;
	}

	get textContent() {
		if (this.nodeType === 3) {
			return this.nodeValue || "";
		}
		return this.childNodes.map((child) => child.textContent).join("");
	}

	set textContent(value) {
		this.childNodes = [];
		if (value != null && value !== "") {
			this.appendChild(this.ownerDocument.createTextNode(String(value)));
		}
	}
}

class FakeTextNode extends FakeNode {
	constructor(ownerDocument, value) {
		super(3, ownerDocument);
		this.nodeValue = String(value || "");
	}

	get textContent() {
		return this.nodeValue;
	}

	set textContent(value) {
		this.nodeValue = String(value || "");
	}
}

class FakeElement extends FakeNode {
	constructor(ownerDocument, namespaceURI, tagName) {
		super(1, ownerDocument);
		this.namespaceURI = namespaceURI;
		this.localName = String(tagName || "").toLowerCase();
		this.nodeName = this.localName;
		this.attributes = new Map();
		this.dataset = {};
	}

	setAttribute(name, value) {
		this.attributes.set(String(name), String(value));
	}

	setAttributeNS(_ns, name, value) {
		this.setAttribute(name, value);
	}

	getAttribute(name) {
		return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null;
	}

	getAttributeNames() {
		return Array.from(this.attributes.keys());
	}

	getAttributeNode(name) {
		let value = this.getAttribute(name);
		return value == null ? null : { namespaceURI: null, name, value };
	}

	hasAttribute(name) {
		return this.attributes.has(String(name));
	}

	get classList() {
		let getClasses = () => String(this.getAttribute("class") || "").split(/\s+/).filter(Boolean);
		let setClasses = (classes) => {
			if (classes.length) {
				this.setAttribute("class", classes.join(" "));
			}
			else {
				this.attributes.delete("class");
			}
		};
		return {
			contains: (name) => getClasses().includes(name),
			add: (...names) => setClasses(Array.from(new Set([...getClasses(), ...names.filter(Boolean)]))),
			remove: (...names) => {
				let removeSet = new Set(names.filter(Boolean));
				setClasses(getClasses().filter((name) => !removeSet.has(name)));
			}
		};
	}

	querySelectorAll(selector) {
		let results = [];
		let visit = (node) => {
			for (let child of node.childNodes || []) {
				if (child.nodeType !== 1) continue;
				if (selector === "*" || selector === child.localName) {
					results.push(child);
				}
				visit(child);
			}
		};
		visit(this);
		return results;
	}
}

class FakeDocumentFragment extends FakeNode {
	constructor(ownerDocument) {
		super(11, ownerDocument);
	}
}

class FakeRange {
	constructor(ownerDocument) {
		this.ownerDocument = ownerDocument;
		this.START_TO_START = 0;
		this.START_TO_END = 1;
		this.END_TO_END = 2;
		this.END_TO_START = 3;
		this.startContainer = ownerDocument.body;
		this.startOffset = 0;
		this.endContainer = ownerDocument.body;
		this.endOffset = 0;
	}

	cloneRange() {
		let clone = new FakeRange(this.ownerDocument);
		clone.startContainer = this.startContainer;
		clone.startOffset = this.startOffset;
		clone.endContainer = this.endContainer;
		clone.endOffset = this.endOffset;
		return clone;
	}

	setStart(container, offset) {
		this.startContainer = container;
		this.startOffset = offset;
	}

	setEnd(container, offset) {
		this.endContainer = container;
		this.endOffset = offset;
	}

	setStartBefore(node) {
		let parent = node.parentNode;
		let index = parent.childNodes.indexOf(node);
		this.setStart(parent, index);
	}

	setEndAfter(node) {
		let parent = node.parentNode;
		let index = parent.childNodes.indexOf(node);
		this.setEnd(parent, index + 1);
	}

	selectNode(node) {
		let parent = node.parentNode;
		let index = parent.childNodes.indexOf(node);
		this.setStart(parent, index);
		this.setEnd(parent, index + 1);
	}

	selectNodeContents(node) {
		if (node.nodeType === 3) {
			this.setStart(node, 0);
			this.setEnd(node, (node.nodeValue || "").length);
			return;
		}
		this.setStart(node, 0);
		this.setEnd(node, node.childNodes.length);
	}

	compareBoundaryPoints(how, sourceRange) {
		let [pointA, pointB] = (() => {
			switch (how) {
				case this.START_TO_START:
					return [[this.startContainer, this.startOffset], [sourceRange.startContainer, sourceRange.startOffset]];
				case this.START_TO_END:
					return [[this.endContainer, this.endOffset], [sourceRange.startContainer, sourceRange.startOffset]];
				case this.END_TO_END:
					return [[this.endContainer, this.endOffset], [sourceRange.endContainer, sourceRange.endOffset]];
				case this.END_TO_START:
				default:
					return [[this.startContainer, this.startOffset], [sourceRange.endContainer, sourceRange.endOffset]];
			}
		})();
		let indexA = this.ownerDocument.pointIndex(pointA[0], pointA[1]);
		let indexB = this.ownerDocument.pointIndex(pointB[0], pointB[1]);
		return indexA === indexB ? 0 : (indexA < indexB ? -1 : 1);
	}
}

class FakeDocument {
	constructor() {
		this.body = new FakeElement(this, "http://www.w3.org/1999/xhtml", "body");
		this.defaultView = { Range: FakeRange };
	}

	createElementNS(namespaceURI, tagName) {
		return new FakeElement(this, namespaceURI, tagName);
	}

	createTextNode(value) {
		return new FakeTextNode(this, value);
	}

	createDocumentFragment() {
		return new FakeDocumentFragment(this);
	}

	createRange() {
		return new FakeRange(this);
	}

	pointIndex(container, offset) {
		let root = container;
		while (root.parentNode) {
			root = root.parentNode;
		}
		let result = this._pointIndexFrom(root, container, offset, 0);
		return result == null ? 0 : result;
	}

	_pointIndexFrom(node, container, offset, startIndex) {
		if (node === container) {
			if (node.nodeType === 3) {
				return startIndex + Math.max(0, Math.min((node.nodeValue || "").length, offset));
			}
			let index = startIndex;
			let limit = Math.max(0, Math.min(node.childNodes.length, offset));
			for (let i = 0; i < limit; i++) {
				index += this.measureNode(node.childNodes[i]);
			}
			return index;
		}
		if (node.nodeType === 3) return null;
		let index = startIndex;
		for (let child of node.childNodes) {
			let found = this._pointIndexFrom(child, container, offset, index);
			if (found != null) return found;
			index += this.measureNode(child);
		}
		return null;
	}

	measureNode(node) {
		if (!node) return 0;
		if (node.nodeType === 3) {
			return Math.max(1, (node.nodeValue || "").length);
		}
		let total = 0;
		for (let child of node.childNodes || []) {
			total += this.measureNode(child);
		}
		return Math.max(1, total);
	}
}

function loadCopilot() {
	globalThis.Zotero = {
		debug() {},
		logError() {},
		Prefs: {
			get() { return undefined; },
			set() {}
		}
	};
	globalThis.ZoteroCopilotKaTeX = null;
	let markedModule = require(path.join(__dirname, "..", "vendor", "marked", "marked.umd.js"));
	globalThis.ZoteroCopilotMarked = markedModule?.marked || markedModule;
	for (let relativePath of [
		"markdown/core.js",
		"markdown/render.js",
		"markdown/copy.js",
		"copilot.js"
	]) {
		let source = fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
		vm.runInThisContext(source, { filename: relativePath });
	}
	return globalThis.ZoteroCopilot;
}

function walkTextNodes(root) {
	let nodes = [];
	let visit = (node) => {
		if (!node) return;
		if (node.nodeType === 3) {
			nodes.push(node);
			return;
		}
		for (let child of node.childNodes || []) {
			visit(child);
		}
	};
	visit(root);
	return nodes;
}

function findTextNode(root, value, occurrence = 0) {
	let matches = walkTextNodes(root).filter((node) => (node.nodeValue || "").includes(value));
	return matches[occurrence] || null;
}

function findElement(root, predicate) {
	let found = null;
	let visit = (node) => {
		if (found || !node || node.nodeType !== 1) return;
		if (predicate(node)) {
			found = node;
			return;
		}
		for (let child of node.childNodes || []) {
			visit(child);
		}
	};
	visit(root);
	return found;
}

function createPRNG(seed) {
	let state = seed >>> 0;
	return () => {
		state = (1664525 * state + 1013904223) >>> 0;
		return state / 0x100000000;
	};
}

function randomInt(rng, max) {
	return Math.floor(rng() * Math.max(1, max));
}

function collectElements(root, predicate) {
	let found = [];
	let visit = (node) => {
		if (!node || node.nodeType !== 1) return;
		if (predicate(node)) {
			found.push(node);
		}
		for (let child of node.childNodes || []) {
			visit(child);
		}
	};
	visit(root);
	return found;
}

function buildRandomRange(doc, root, rng) {
	let textNodes = walkTextNodes(root).filter((node) => (node.nodeValue || "").length > 0);
	if (!textNodes.length) {
		let range = doc.createRange();
		range.selectNodeContents(root);
		return range;
	}
	let startIndex = randomInt(rng, textNodes.length);
	let endIndex = randomInt(rng, textNodes.length);
	if (startIndex > endIndex) {
		[startIndex, endIndex] = [endIndex, startIndex];
	}
	let startNode = textNodes[startIndex];
	let endNode = textNodes[endIndex];
	let startOffset = randomInt(rng, (startNode.nodeValue || "").length + 1);
	let endOffset = randomInt(rng, (endNode.nodeValue || "").length + 1);
	if (startNode === endNode && startOffset > endOffset) {
		[startOffset, endOffset] = [endOffset, startOffset];
	}
	let range = doc.createRange();
	range.setStart(startNode, startOffset);
	range.setEnd(endNode, endOffset);
	return range;
}

function assert(name, condition, details = "") {
	if (!condition) {
		throw new Error(details ? `${name}\n${details}` : name);
	}
	console.log(`PASS ${name}`);
}

function ensure(name, condition, details = "") {
	if (!condition) {
		throw new Error(details ? `${name}\n${details}` : name);
	}
}

function renderRoot(copilot, markdown) {
	let doc = new FakeDocument();
	let root = doc.createElementNS(copilot.HTML_NS, "div");
	root.setAttribute("class", "zc-markdown");
	root.dataset = {};
	doc.body.appendChild(root);
	copilot.setMarkdownContent(root, markdown);
	return { doc, root };
}

function assertEqual(name, actual, expected) {
	if (actual !== expected) {
		throw new Error(`${name}\nExpected: ${JSON.stringify(expected)}\nActual:   ${JSON.stringify(actual)}`);
	}
	console.log(`PASS ${name}`);
}

function runRandomCopyFuzz(copilot, sampleName, markdown, seed, iterations = 150) {
	let run = () => {
		let rng = createPRNG(seed);
		let { doc, root } = renderRoot(copilot, markdown);
		let outputs = [];
		for (let i = 0; i < iterations; i++) {
			let range = copilot.normalizeRangeForCopy(buildRandomRange(doc, root, rng));
			let serialized = copilot.serializeSelectedMarkdownRoot(root, range);
			outputs.push(serialized);
			ensure(`${sampleName} random selection ${i + 1} returns normalized markdown`, serialized === copilot.normalizeCopiedMarkdown(serialized), `Unexpected output: ${JSON.stringify(serialized)}`);
		}
		return { doc, root, outputs };
	};

	let first = run();
	let second = run();
	assertEqual(`${sampleName} random copy is deterministic for seed ${seed}`, JSON.stringify(first.outputs), JSON.stringify(second.outputs));
	assert(`${sampleName} random selections stay normalized`, true);

	let formulaTextNodes = walkTextNodes(first.root).filter((node) => node.parentElement?.getAttribute?.("data-md-formula"));
	if (formulaTextNodes.length) {
		let formulaNode = formulaTextNodes[0];
		let formulaSource = formulaNode.parentElement.getAttribute("data-md-formula");
		let range = first.doc.createRange();
		let length = (formulaNode.nodeValue || "").length;
		range.setStart(formulaNode, Math.min(1, length));
		range.setEnd(formulaNode, Math.max(Math.min(length - 1, length), 0));
		let normalized = copilot.normalizeRangeForCopy(range);
		let serialized = copilot.serializeSelectedMarkdownRoot(first.root, normalized);
		assert(
			`${sampleName} random fuzz formula partial selection preserves full formula source`,
			serialized.includes(formulaSource),
			`Expected serialized selection to include ${JSON.stringify(formulaSource)} but got ${JSON.stringify(serialized)}`
		);
	}

	let sourceNodes = collectElements(
		first.root,
		(node) => !!node.getAttribute?.("data-md-source")
			&& node.parentElement === first.root
			&& !["ul", "ol", "blockquote", "table"].includes(String(node.localName || "").toLowerCase())
	);
	if (sourceNodes.length) {
		let target = sourceNodes[Math.min(1, sourceNodes.length - 1)];
		let range = first.doc.createRange();
		range.selectNodeContents(target);
		assertEqual(
			`${sampleName} full annotated node selection returns source`,
			copilot.serializeSelectedMarkdownRoot(first.root, range),
			copilot.normalizeCopiedMarkdown(target.dataset?.markdownSource || target.getAttribute("data-md-source"))
		);
	}
}

function main() {
	let copilot = loadCopilot();

	{
		let { doc, root } = renderRoot(copilot, "Alpha **beta** gamma");
		let range = doc.createRange();
		range.selectNodeContents(root);
		assertEqual("full root copy preserves source", copilot.serializeSelectedMarkdownRoot(root, range), "Alpha **beta** gamma");
		assertEqual("paragraph source annotation", root.children[0].getAttribute("data-md-source"), "Alpha **beta** gamma");
		let strong = findElement(root, (node) => node.localName === "strong");
		assertEqual("strong source annotation", strong?.getAttribute("data-md-source") || "", "**beta**");
	}

	{
		let { doc, root } = renderRoot(copilot, "这是 **增广拉格朗日法（AL）** 的例子");
		let strong = findElement(root, (node) => node.localName === "strong");
		assertEqual("cjk strong node is rendered", strong?.textContent || "", "增广拉格朗日法（AL）");
		let range = doc.createRange();
		range.selectNodeContents(strong);
		assertEqual("cjk strong selection copies markdown", copilot.serializeSelectedMarkdownRoot(root, range), "**增广拉格朗日法（AL）**");
	}

	{
		let sample = "采用**增广拉格朗日法（AL）**处理大量局部约束（应力、局部屈曲、几何约束），避免直接处理大规模约束矩阵。";
		let { doc, root } = renderRoot(copilot, sample);
		let strong = findElement(root, (node) => node.localName === "strong");
		assertEqual("cjk-adjacent strong node is rendered", strong?.textContent || "", "增广拉格朗日法（AL）");
		let range = doc.createRange();
		range.selectNodeContents(root);
		assertEqual("cjk-adjacent full root copy preserves source", copilot.serializeSelectedMarkdownRoot(root, range), sample);
		range.selectNodeContents(strong);
		assertEqual("cjk-adjacent strong selection copies markdown", copilot.serializeSelectedMarkdownRoot(root, range), "**增广拉格朗日法（AL）**");
	}

	{
		let sample = "这篇文章提出了一种**基于增广拉格朗日法（Augmented Lagrangian）的桁架拓扑优化框架**，核心贡献是同时考虑**全局/局部稳定性、应力约束和几何可行性（重叠/交叉）**的集成优化方法。";
		let { doc, root } = renderRoot(copilot, sample);
		let strongNodes = [];
		let visit = (node) => {
			if (!node) return;
			if (node.nodeType === 1 && node.localName === "strong") {
				strongNodes.push(node);
			}
			for (let child of node.childNodes || []) {
				visit(child);
			}
		};
		visit(root);
		assertEqual("multiple cjk-adjacent strong nodes are rendered", String(strongNodes.length), "2");
		assertEqual("second cjk-adjacent strong text is preserved", strongNodes[1]?.textContent || "", "全局/局部稳定性、应力约束和几何可行性（重叠/交叉）");
		let range = doc.createRange();
		range.selectNodeContents(strongNodes[1]);
		assertEqual("second cjk-adjacent strong selection copies markdown", copilot.serializeSelectedMarkdownRoot(root, range), "**全局/局部稳定性、应力约束和几何可行性（重叠/交叉）**");
	}

	{
		let { doc, root } = renderRoot(copilot, "Alpha **beta** gamma");
		let startNode = findTextNode(root, "Alpha ");
		let endNode = findTextNode(root, " gamma");
		let range = doc.createRange();
		range.setStart(startNode, 2);
		range.setEnd(endNode, 3);
		assertEqual("partial text across strong copies smoothly", copilot.serializeSelectedMarkdownRoot(root, range), "pha **beta** ga");
	}

	{
		let { doc, root } = renderRoot(copilot, "Alpha  \nBeta");
		let firstLine = findTextNode(root, "Alpha");
		let secondLine = findTextNode(root, "Beta");
		let range = doc.createRange();
		range.setStart(firstLine, 2);
		range.setEnd(secondLine, 2);
		assertEqual("hard line break selection preserves markdown line break", copilot.serializeSelectedMarkdownRoot(root, range), "pha  \nBe");
	}

	{
		let sample = "- **$k_{g4}^e$：保留所有线性项（本文推荐）**";
		let { doc, root } = renderRoot(copilot, sample);
		let strong = findElement(root, (node) => node.localName === "strong");
		assertEqual("strong with inline formula is rendered", strong?.textContent || "", "$k_{g4}^e$：保留所有线性项（本文推荐）");
		let range = doc.createRange();
		range.selectNodeContents(strong);
		assertEqual("strong with inline formula selection preserves markdown inside list item", copilot.serializeSelectedMarkdownRoot(root, range), "- **$k_{g4}^e$：保留所有线性项（本文推荐）**");
		range.selectNodeContents(root);
		assertEqual("strong with inline formula full root copy preserves source", copilot.serializeSelectedMarkdownRoot(root, range), sample);
	}

	{
		let { doc, root } = renderRoot(copilot, "Before $x^2$ after");
		let formulaText = findTextNode(root, "$x^2$");
		let range = doc.createRange();
		range.setStart(formulaText, 2);
		range.setEnd(formulaText, 4);
		let normalized = copilot.normalizeRangeForCopy(range);
		assertEqual("inline formula partial selection copies whole formula", copilot.serializeSelectedMarkdownRoot(root, normalized), "$x^2$");
	}

	{
		let { doc, root } = renderRoot(copilot, "Intro\n\n$$\na+b\n$$\n\nTail");
		let formulaText = findTextNode(root, "$$\na+b\n$$");
		let range = doc.createRange();
		range.setStart(formulaText, 3);
		range.setEnd(formulaText, 4);
		let normalized = copilot.normalizeRangeForCopy(range);
		assertEqual("display formula partial selection copies whole block formula", copilot.serializeSelectedMarkdownRoot(root, normalized), "$$\na+b\n$$");
	}

	{
		let sample = "Intro\n\n$$\nx_{ph,e} = \n\\\\begin{cases} \n123 \\\\\n123 \\\\\n123\n\\\\end{cases}\n$$\n\nTail";
		let { doc, root } = renderRoot(copilot, sample);
		let introText = findTextNode(root, "Intro");
		let formulaText = findTextNode(root, "$$\nx_{ph,e} = \n\\\\begin{cases} \n123 \\\\\n123 \\\\\n123\n\\\\end{cases}\n$$");
		let tailText = findTextNode(root, "Tail");
		let range = doc.createRange();
		range.setStart(formulaText, 5);
		range.setEnd(formulaText, 8);
		let normalized = copilot.normalizeRangeForCopy(range, {
			anchorNode: formulaText,
			anchorOffset: 5,
			focusNode: tailText,
			focusOffset: 2
		});
		let serialized = copilot.serializeSelectedMarkdownRoot(root, normalized);
		assert(
			"display formula selection rebuilt from anchor/focus keeps trailing content",
			serialized.includes("$$\nx_{ph,e} =") && serialized.endsWith("\n\nT"),
			`Unexpected serialized content: ${JSON.stringify(serialized)}`
		);

		let leftRange = doc.createRange();
		leftRange.setStart(formulaText, 5);
		leftRange.setEnd(formulaText, 8);
		let normalizedLeft = copilot.normalizeRangeForCopy(leftRange, {
			anchorNode: introText,
			anchorOffset: 2,
			focusNode: formulaText,
			focusOffset: 8
		});
		let serializedLeft = copilot.serializeSelectedMarkdownRoot(root, normalizedLeft);
		assert(
			"display formula selection keeps leading content",
			serializedLeft.startsWith("tro\n\n$$\nx_{ph,e} ="),
			`Unexpected serialized content: ${JSON.stringify(serializedLeft)}`
		);

		let bothRange = doc.createRange();
		bothRange.setStart(formulaText, 5);
		bothRange.setEnd(formulaText, 8);
		let normalizedBoth = copilot.normalizeRangeForCopy(bothRange, {
			anchorNode: introText,
			anchorOffset: 1,
			focusNode: tailText,
			focusOffset: 3
		});
		let serializedBoth = copilot.serializeSelectedMarkdownRoot(root, normalizedBoth);
		assert(
			"display formula selection keeps both leading and trailing content",
			serializedBoth.startsWith("ntro\n\n$$\nx_{ph,e} =") && serializedBoth.includes("$$\n\nTa"),
			`Unexpected serialized content: ${JSON.stringify(serializedBoth)}`
		);

		let backwardRange = doc.createRange();
		backwardRange.setStart(formulaText, 5);
		backwardRange.setEnd(formulaText, 8);
		let normalizedBackward = copilot.normalizeRangeForCopy(backwardRange, {
			anchorNode: tailText,
			anchorOffset: 3,
			focusNode: introText,
			focusOffset: 1
		});
		let serializedBackward = copilot.serializeSelectedMarkdownRoot(root, normalizedBackward);
		assertEqual(
			"display formula forward and backward selections serialize identically",
			serializedBackward,
			serializedBoth
		);
	}

	{
		let sample = fs.readFileSync(path.join(__dirname, "..", "test", "test1.txt"), "utf8").replace(/\r\n?/g, "\n");
		let { doc, root } = renderRoot(copilot, sample);
		let range = doc.createRange();
		range.selectNodeContents(root);
		assertEqual(
			"test1 full root copy preserves normalized markdown",
			copilot.serializeSelectedMarkdownRoot(root, range),
			copilot.normalizeCopiedMarkdown(sample)
		);
	}

	runRandomCopyFuzz(copilot, "plain-text", "Alpha **beta** gamma", 12345, 120);
	runRandomCopyFuzz(copilot, "cjk-strong", "这篇文章提出了一种**基于增广拉格朗日法（Augmented Lagrangian）的桁架拓扑优化框架**，核心贡献是同时考虑**全局/局部稳定性、应力约束和几何可行性（重叠/交叉）**的集成优化方法。", 22334, 120);
	runRandomCopyFuzz(copilot, "list-formula", "- **$k_{g4}^e$：保留所有线性项（本文推荐）**\n- 普通项\n\n$$\na+b\n$$", 9988, 180);
	runRandomCopyFuzz(copilot, "table-formula", "| 项 | 公式 |\n| --- | --- |\n| A | $x^2$ |\n| B | **$y^2$** |", 7788, 160);
	runRandomCopyFuzz(copilot, "blockquote", "> 第一段 **重点**\n>\n> 第二段含有 $z$ 与普通文本", 5566, 120);
	runRandomCopyFuzz(copilot, "long-sample", fs.readFileSync(path.join(__dirname, "..", "test", "test1.txt"), "utf8").replace(/\r\n?/g, "\n"), 424242, 220);
}

main();
