const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const files = new Map();
const items = new Map();
globalThis.Zotero = { debug() {}, Items: { get: id => items.get(id),
	getByLibraryAndKey: (libraryID, key) => [...items.values()].find(item => item.libraryID === libraryID && item.key === key) } };
globalThis.IOUtils = { async readUTF8(file) {
	if (!files.has(file)) throw new Error('File unavailable');
	return files.get(file);
} };
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'copilot.js'), 'utf8'));
const c = globalThis.ZoteroCopilot;
const markdown = '# 原文\n\n$x < y$\n\n| A | B |\n|---|---|\n| 1 | 2 |';
function attachment(file, type, tagged = true) {
	return { id: 2, key: 'ATT', libraryID: 1, parentItemID: 1,
		attachmentContentType: type, attachmentFilename: path.basename(file),
		isAttachment: () => true, getFilePath: async () => file,
		getField: field => field === 'title' ? '解析结果' : '',
		getTags: () => tagged ? [{ tag: '#MinerU-Parse' }] : [] };
}
const html = attachment('/storage/paper.HTML', 'text/html');
const pdf = { ...attachment('/storage/paper.pdf', 'application/pdf', false), id: 3,
	isPDFAttachment: () => true, attachmentText: 'PDF fallback' };
const parent = { id: 1, key: 'PARENT', libraryID: 1, isRegularItem: () => true,
	getAttachments: () => [2, 3], getField: () => 'Paper' };
items.set(2, html);
items.set(3, pdf);
function embed(value) {
	return `<html><style>DO NOT READ</style><script id='mineru-source' type='application/json'>${JSON.stringify(value)}</script></html>`;
}
async function main() {
	await checkRelations();
	const md = attachment('/storage/old.md', 'text/markdown', false);
	files.set('/storage/old.md', markdown);
	assert.equal((await c.readAttachmentMarkdown(md)).markdown, markdown);
	assert(c.isMineruParseAttachment(html));
	assert(!c.isMineruParseAttachment(attachment('/x.html', 'text/html', false)));
	assert.equal(c.findMineruMarkdownAttachment(parent), html);
	files.set('/storage/paper.md', markdown);
	files.set('/storage/paper.HTML', embed({ markdown: 'embedded' }));
	assert.equal((await c.readAttachmentMarkdown(html)).source, 'companion-markdown');
	assert.equal((await c.readAttachmentMarkdown(html)).markdown, markdown);
	for (const companion of [null, '', ' \n']) {
		if (companion === null) files.delete('/storage/paper.md');
		else files.set('/storage/paper.md', companion);
		files.set('/storage/paper.HTML', embed({ markdown }));
		const result = await c.readAttachmentMarkdown(html);
		assert.equal(result.source, 'html-embedded-markdown');
		assert.equal(result.markdown, markdown);
	}
	assert.equal((await c.resolveMarkdownSource(html)).sourceRef.parser, 'markdown-file');
	assert.equal((await c.resolveContextSource(html, null)).ok, true);
	assert.equal((await c.resolveContextSource(attachment('/other.html', 'text/html', false), null)).ok, false);
	assert.equal(await c.buildMineruSummaryPlainText(html), markdown);
	c.resolveItemRef = () => parent;
	c.getToolExecutionWindow = () => null;
	assert.equal((await c.runGetArticleContentTool({})).parser, 'mineru-markdown');
	assert.equal((await c.extractPDFTextWithFallback(pdf, parent, null)).parser, 'mineru-markdown');
	c.getWindowConversationRuntimeConfig = () => ({ regularItemContextMode: 'full' });
	assert.equal((await c.resolveRegularItemSource(parent, null)).sourceRef.parser, 'mineru-markdown');
	for (const bad of [embed({}), embed({ markdown: 5 }), embed({ markdown: '' }),
		'<script type="application/json" id="mineru-source">{broken</script>', '<html>Rendered only</html>', null]) {
		if (bad === null) files.delete('/storage/paper.HTML');
		else files.set('/storage/paper.HTML', bad);
		await assert.rejects(c.readAttachmentMarkdown(html), /请重新解析 PDF/);
		assert.equal((await c.resolveMarkdownSource(html)).ok, false);
		await assert.rejects(c.buildMineruSummaryPlainText(html), /请重新解析 PDF/);
		await assert.rejects(c.runGetArticleContentTool({}), /请重新解析 PDF/);
		assert.equal((await c.extractPDFTextWithFallback(pdf, parent, null)).parser, 'zotero-fulltext');
		assert.equal((await c.resolveRegularItemSource(parent, null)).sourceRef.parser, 'zotero-fulltext');
	}
	// Ensure a newly parsed HTML attachment is discovered and read on the same call.
	items.delete(2);
	let parses = 0;
	const runtime = { getSettings: () => ({ apiToken: 'test' }),
		async parseAttachmentWithMineru() { parses++; return { rawMarkdownText: markdown }; },
		async saveResultAsMarkdownAttachment() {
			items.set(2, html);
			files.set('/storage/paper.md', markdown);
		} };
	assert.equal(await c.ensureMineruMarkdownAttachment(parent, { ZoteroMineru: runtime }), html);
	assert.equal((await c.readAttachmentMarkdown(html)).markdown, markdown);
	assert.equal(parses, 1);
	files.set('/storage/paper.md', 'x'.repeat(70000));
	assert.equal((await c.buildMineruSummaryPlainText(html)).length, 60000);
	console.log('MinerU attachment reading regression checks passed');
}

async function checkRelations() {
	const originalItems = new Map(items);
	const originalReader = c.getCurrentReaderPDFAttachment;
	const originalLog = c.log;
	const warnings = [];
	c.log = message => warnings.push(message);
	const makePDF = id => ({ ...pdf, id, key: `PDF${id}`, relatedItems: [] });
	const makeResult = id => ({ ...attachment(`/storage/${id}.md`, 'text/markdown'),
		id, key: `MD${id}`, relatedItems: [] });
	const a = makePDF(10), b = makePDF(11), ra = makeResult(20), rb = makeResult(21);
	let children = [a.id, b.id, ra.id, rb.id];
	const article = { ...parent, getAttachments: () => children };
	const link = (source, result) => { source.relatedItems = [result.key]; result.relatedItems = [source.key]; };
	try {
		items.clear();
		for (const item of [article, a, b, ra, rb]) items.set(item.id, item);
		files.set('/storage/20.md', 'Article A');
		files.set('/storage/21.md', 'Article B');
		link(b, rb);
		assert.equal(c.findMineruMarkdownAttachment(article), rb);
		assert.equal(c.findMineruMarkdownAttachment(article, a), null);
		assert.equal((await c.extractPDFTextWithFallback(a, article, null)).parser, 'zotero-fulltext');
		link(a, ra);
		assert.equal(c.findMineruMarkdownAttachment(article), ra);
		assert.equal((await c.extractPDFTextWithFallback(b, article, null)).text, 'Article B');
		c.getWindowConversationRuntimeConfig = () => ({ regularItemContextMode: 'full' });
		a.relatedItems = [];
		assert.equal((await c.resolveRegularItemSource(article, null)).sourceRef.textSnapshot, 'Article B');
		c.resolveItemRef = () => article;
		c.getToolExecutionWindow = () => null;
		assert.equal((await c.runGetArticleContentTool({})).content, 'Article B');
		assert.equal(await c.buildMineruSummaryPlainText(await c.ensureMineruMarkdownAttachment(article, null)), 'Article B');
		link(a, ra);
		// Related items survive reparenting and renaming, including standalone PDFs.
		ra.parentItemID = 99;
		ra.getField = () => 'Renamed result';
		a.parentItemID = null;
		children = [b.id, rb.id];
		assert.equal(c.findMineruMarkdownAttachment(null, a), ra);
		c.getCurrentReaderPDFAttachment = () => a;
		assert.equal((await c.getContextMenuActions({ window: null }))[1].items[0], ra);
		assert.equal((await c.resolvePDFAttachmentSource(a, null)).sourceRef.textSnapshot, 'Article A');
		const newer = makeResult(22);
		items.set(newer.id, newer);
		a.relatedItems.push(newer.key);
		assert.equal(c.findMineruMarkdownAttachment(null, a), newer);
		newer.deleted = true;
		const foreign = { ...makeResult(23), libraryID: 2 };
		const ordinary = { ...makeResult(24), getTags: () => [] };
		items.set(23, foreign); items.set(24, ordinary);
		a.relatedItems.push('MISSING', foreign.key, ordinary.key);
		assert.equal(c.findMineruMarkdownAttachment(null, a), ra);
		ra.deleted = true;
		assert.equal(c.findMineruMarkdownAttachment(null, a), null);
		ra.deleted = false;
		// Conservative legacy compatibility.
		a.relatedItems = []; ra.relatedItems = []; a.parentItemID = 1;
		children = [a.id, ra.id];
		assert.equal(c.findMineruMarkdownAttachment(article, a), ra);
		ra.relatedItems = [b.key];
		assert.equal(c.findMineruMarkdownAttachment(article, a), null);
		ra.relatedItems = [];
		children.push(rb.id);
		assert.equal(c.findMineruMarkdownAttachment(article, a), null);
		children = [ra.id];
		assert.equal(c.findMineruMarkdownAttachment(article), ra);
		children.push(rb.id);
		assert.equal(c.findMineruMarkdownAttachment(article), null);
		// New API returns the saved item even when linking fails or siblings are ambiguous.
		children = [a.id, b.id]; b.relatedItems = [];
		const runtime = { getSettings: () => ({ apiToken: 'test' }),
			async parseAttachmentWithMineru(source) { assert.equal(source, a); return { markdownText: 'Article A' }; },
			async saveResultAsMarkdownAttachment() { return { attachment: ra, warning: 'link failed' }; } };
		assert.equal(await c.ensureMineruMarkdownAttachment(article, { ZoteroMineru: runtime }), ra);
		assert(warnings.some(message => message.includes('link failed')));
		runtime.parseAttachmentWithMineru = async () => ({ markdownText: 'Live raw text' });
		const live = await c.extractPDFTextWithFallback(a, article, { ZoteroMineru: runtime });
		assert.equal(live.text, 'Article A');
		assert.equal(live.parser, 'mineru-live');
		a.parentItemID = null;
		assert.equal((await c.extractPDFTextWithFallback(a, null, { ZoteroMineru: runtime })).text, 'Article A');
		runtime.saveResultAsMarkdownAttachment = async () => { link(a, ra); };
		assert.equal(await c.ensureMineruMarkdownAttachment(article, { ZoteroMineru: runtime }), ra);
	} finally {
		items.clear();
		for (const [id, item] of originalItems) items.set(id, item);
		c.getCurrentReaderPDFAttachment = originalReader;
		c.log = originalLog;
	}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
