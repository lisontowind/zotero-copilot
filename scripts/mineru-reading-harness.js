const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const files = new Map();
const items = new Map();
globalThis.Zotero = { debug() {}, Items: { get: id => items.get(id) } };
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
main().catch(error => { console.error(error); process.exitCode = 1; });
