"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "copilot.js"), "utf8");
const llm = { apiBaseURL: "https://example.invalid/v1", apiKey: "test", model: "test", requestJSON: "" };
const clone = (value) => JSON.parse(JSON.stringify(value));
const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
	let resolve, reject;
	const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function runtime({ abortController = true } = {}) {
	const errors = [];
	const scope = { AbortController: abortController ? AbortController : undefined, TextDecoder, DOMException,
		Zotero: { debug() {}, logError: (error) => errors.push(error), Prefs: { get() {}, set() {} } },
		fetch: async () => { throw new Error("Unexpected network request in regression test"); } };
	vm.createContext(scope);
	vm.runInContext(source, scope, { filename: "copilot.js" });
	const c = scope.ZoteroCopilot;
	c.getActiveSystemPrompt = () => ({ content: "Academic assistant" });
	c.getChatHistoryMessageCount = () => 20;
	return { c, scope, errors };
}

function chatRig(options) {
	const rig = runtime(options);
	const { c } = rig;
	const session = { item: {}, attachment: { id: 1 }, store: {}, data: {
		sessionID: "test-session", title: "Existing title", autoTitleLocked: true, messages: [] } };
	const state = { window: {}, currentSession: session, sessions: [session], sendButton: {}, stopButton: {}, input: {},
		sessionSelect: { setAttribute() {} } };
	let persisted = clone(session.data);
	rig.saved = [];
	rig.statuses = [];
	c.updateSendButton = () => {};
	c.renderCurrentSession = () => {};
	c.renderSessionMenu = () => {};
	c.setStatus = (_state, message, error = false) => rig.statuses.push({ message, error });
	c.cancelStreamingRender = () => {};
	c.updateStreamingText = () => {};
	c.finalizeStreamingText = () => {};
	c.ensureReasoningNode = () => {};
	c.appendStreamingAssistantMessage = () => ({
		message: { messageID: c.makeID("assistant"), role: "assistant", content: "", reasoning: "" },
		node: { remove() {} }, stopWaiting() {}, contentRender: {}, reasoningRender: null
	});
	c.writeSession = async (entry) => { persisted = clone(entry.data); rig.saved.push(clone(entry.data)); };
	c.loadSessionAttachment = async () => ({ ...session, data: clone(persisted) });
	rig.originalRefreshSessions = c.refreshSessions;
	c.refreshSessions = async () => {
		state.currentSession = { ...session, data: clone(persisted) };
		state.sessions = [state.currentSession];
	};
	c.requestChatCompletion = async ({ onDelta }) => { onDelta({ type: "content", text: "Answer" }); return "Answer"; };
	c.generateSessionTitle = async () => "Generated title";
	return Object.assign(rig, { session, state, persisted: () => clone(persisted),
		send: (content = "Question", extra = {}) => c.runUserTurn(state, {
			session: state.currentSession, userMessage: { messageID: c.makeID("user"), role: "user", content }, ...extra
		}) });
}

function assertIdle(state) {
	assert.equal(state.isSending, false);
	assert.equal(state.input.disabled, false);
	assert.equal(state.sendButton.disabled, false);
	assert.equal(state.activeRequestID, null);
	assert.equal(state.currentStreaming, null);
	assert.equal(state.requestAbortController, null);
}

test("initial save failure restores controls without starting a model request", async () => {
	const { c, state, session, send, statuses } = chatRig();
	let requests = 0, saves = 0;
	c.writeSession = async () => { saves++; throw new Error("disk unavailable"); };
	c.requestChatCompletion = async () => { requests++; };
	await send();
	assertIdle(state);
	assert.equal(requests, 0);
	assert.equal(saves, 1);
	assert.equal(session.data.messages[0].content, "Question");
	assert.match(statuses.at(-1).message, /保存会话失败.*disk unavailable/);
});

test("answer save failure retains one answer and restores controls", async () => {
	const { c, state, session, send, statuses } = chatRig();
	let saves = 0;
	c.writeSession = async () => { if (++saves === 2) throw new Error("read only"); };
	await send();
	assertIdle(state);
	assert.equal(session.data.messages.filter((message) => message.role === "assistant").length, 1);
	assert.equal(session.data.messages.at(-1).content, "Answer");
	assert.match(statuses.at(-1).message, /保存回答失败.*read only/);
});

test("network and error-save failures keep partial text and unlock the composer", async () => {
	const { c, state, session, send, statuses } = chatRig();
	let saves = 0;
	c.writeSession = async () => { if (++saves > 1) throw new Error("disk full"); };
	c.requestChatCompletion = async ({ onDelta }) => {
		onDelta({ type: "content", text: "Partial answer" });
		throw new Error("connection lost");
	};
	await send();
	assertIdle(state);
	assert(session.data.messages.some((message) => message.content === "Partial answer"));
	assert.match(statuses.at(-1).message, /connection lost.*disk full/);
});

test("stop during the initial save does not start title or chat requests", async () => {
	const { c, state, send } = chatRig();
	const saving = deferred(), started = deferred();
	let saves = 0, requests = 0;
	c.writeSession = async () => { if (++saves === 1) { started.resolve(); await saving.promise; } };
	c.requestChatCompletion = c.generateSessionTitle = async () => { requests++; };
	const turn = send();
	await started.promise;
	c.handleStopGeneration(state);
	saving.resolve();
	await turn;
	assertIdle(state);
	assert.equal(requests, 0);
});

test("reader cancellation works without AbortController and preserves partial output once", async () => {
	const { c, state, session, send } = chatRig({ abortController: false });
	const reply = deferred(), started = deferred();
	let cancellations = 0;
	c.requestChatCompletion = async ({ onReader, onDelta }) => {
		onReader({ cancel() { cancellations++; return Promise.reject(new Error("already closed")); } });
		onDelta({ type: "content", text: "Partial" });
		started.resolve();
		return reply.promise;
	};
	const turn = send();
	await started.promise;
	c.handleStopGeneration(state);
	const finalizing = state.currentStreaming.finalizingPromise;
	c.handleStopGeneration(state);
	await finalizing;
	assertIdle(state);
	assert(cancellations > 0);
	assert.equal(session.data.messages.filter((message) => message.stopped).length, 1);
	reply.resolve("Late answer");
	await turn;
	assert.equal(session.data.messages.at(-1).content, "Partial");
	await flush();
});

test("stop-save failure still restores controls", async () => {
	const { c, state, send, statuses } = chatRig();
	const reply = deferred(), started = deferred();
	let saves = 0;
	c.writeSession = async () => { if (++saves > 1) throw new Error("stop save failed"); };
	c.requestChatCompletion = async () => { started.resolve(); return reply.promise; };
	const turn = send();
	await started.promise;
	c.handleStopGeneration(state);
	await assert.rejects(state.currentStreaming.finalizingPromise, /stop save failed/);
	await flush();
	assertIdle(state);
	assert.match(statuses.at(-1).message, /停止生成失败/);
	reply.resolve("Late answer");
	await turn;
});

test("a stopped request resolving late cannot clear a newer request", async () => {
	const { c, state, send } = chatRig({ abortController: false });
	const firstReply = deferred(), secondReply = deferred(), firstStarted = deferred(), secondStarted = deferred();
	let calls = 0;
	c.requestChatCompletion = async () => {
		if (++calls === 1) { firstStarted.resolve(); return firstReply.promise; }
		secondStarted.resolve(); return secondReply.promise;
	};
	const first = send("First");
	await firstStarted.promise;
	c.handleStopGeneration(state);
	await state.currentStreaming.finalizingPromise;
	const second = send("Second");
	await secondStarted.promise;
	const secondID = state.activeRequestID;
	firstReply.resolve("Old answer");
	await first;
	assert.equal(state.isSending, true);
	assert.equal(state.activeRequestID, secondID);
	secondReply.resolve("New answer");
	await second;
	assertIdle(state);
	assert.equal(state.currentSession.data.messages.at(-1).content, "New answer");
});

test("a slow auto-title does not block the answer or overwrite a later turn", async () => {
	const rig = chatRig();
	const { c, state, session, send } = rig;
	session.data.autoTitleLocked = false;
	const title = deferred(), applied = deferred();
	c.generateSessionTitle = () => title.promise;
	const apply = c.applyGeneratedSessionTitle;
	c.applyGeneratedSessionTitle = async (...args) => { await apply.apply(c, args); applied.resolve(); };
	await send("First question");
	assertIdle(state);
	assert.equal(rig.persisted().messages.at(-1).content, "Answer");
	await send("Second question");
	title.resolve("Research discussion");
	await applied.promise;
	assert.equal(rig.persisted().title, "Research discussion");
	assert.equal(rig.persisted().messages.length, 4);
	assert.equal(state.currentSession.data.messages.length, 4);
});

test("a late session refresh from a stopped turn cannot replace a newer stream", async () => {
	const rig = chatRig();
	const { c, state, session, send } = rig;
	c.refreshSessions = rig.originalRefreshSessions;
	const loading = deferred(), refreshStarted = deferred(), secondReply = deferred(), secondStarted = deferred();
	let loads = 0;
	c.getAllSessions = async () => {
		if (++loads === 1) { refreshStarted.resolve(); return loading.promise; }
		return [session];
	};
	let switches = 0;
	c.switchToSession = async () => { switches++; };
	const first = send("First");
	await refreshStarted.promise;
	c.handleStopGeneration(state);
	await state.currentStreaming.finalizingPromise;
	c.requestChatCompletion = async () => { secondStarted.resolve(); return secondReply.promise; };
	const second = send("Second");
	await secondStarted.promise;
	const secondID = state.activeRequestID;
	loading.resolve([{ ...session, data: { ...session.data, title: "Stale title" } }]);
	await first;
	assert.equal(switches, 0);
	assert.equal(state.isSending, true);
	assert.equal(state.activeRequestID, secondID);
	secondReply.resolve("New answer");
	await second;
	assert.equal(switches, 1);
	assertIdle(state);
});

test("a generated title never replaces a manual rename or revives a deleted session", async () => {
	for (const action of ["rename", "delete"]) {
		const rig = chatRig();
		const { c, state, session, send } = rig;
		session.data.autoTitleLocked = false;
		const title = deferred(), applied = deferred();
		c.generateSessionTitle = () => title.promise;
		const apply = c.applyGeneratedSessionTitle;
		c.applyGeneratedSessionTitle = async (...args) => { await apply.apply(c, args); applied.resolve(); };
		await send();
		if (action === "rename") {
			state.currentSession.data.title = "My title";
			await c.saveSession(state.currentSession);
		}
		else session.attachment.deleted = true;
		const writes = rig.saved.length;
		title.resolve("Generated title");
		await applied.promise;
		assert.equal(rig.saved.length, writes);
		if (action === "rename") assert.equal(rig.persisted().title, "My title");
	}
});

test("a failed title request leaves the fallback title and successful answer intact", async () => {
	const { c, state, session, send } = chatRig();
	session.data.autoTitleLocked = false;
	c.generateSessionTitle = async () => { throw new Error("title model offline"); };
	await send("Fallback title");
	await flush();
	assertIdle(state);
	assert.equal(state.currentSession.data.title, "Fallback title");
	assert.equal(state.currentSession.data.messages.at(-1).content, "Answer");
});

test("a manual rename arriving during title I/O is preserved", async () => {
	for (const phase of ["read", "write"]) {
		const rig = chatRig();
		const { c, state, session, send } = rig;
		await send();
		const gate = deferred(), started = deferred();
		const originalRead = c.loadSessionAttachment, originalWrite = c.writeSession;
		if (phase === "read") c.loadSessionAttachment = async (...args) => {
			const entry = await originalRead(...args);
			started.resolve(); await gate.promise; return entry;
		};
		else c.writeSession = async (entry) => {
			if (entry.data.title === "AI title") { started.resolve(); await gate.promise; }
			await originalWrite(entry);
		};
		const applying = c.applyGeneratedSessionTitle(state, session, session.data.messages[0].messageID, "Existing title", "AI title");
		await started.promise;
		state.currentSession.data.title = "Manual title";
		const saving = c.saveSession(state.currentSession);
		gate.resolve();
		await Promise.all([applying, saving]);
		assert.equal(state.currentSession.data.title, "Manual title");
		assert.equal(rig.persisted().title, "Manual title");
	}
});

test("session saves serialize, recover after failures, and release their queue", async () => {
	const { c, session } = chatRig();
	const gate = deferred(), started = deferred();
	const order = [];
	c.writeSession = async () => {
		order.push("start");
		if (order.length === 1) { started.resolve(); await gate.promise; throw new Error("first failed"); }
		order.push("finish");
	};
	const first = c.saveSession(session);
	const firstRejected = assert.rejects(first, /first failed/);
	await started.promise;
	const second = c.saveSession(session);
	await flush();
	assert.deepEqual(order, ["start"]);
	gate.resolve();
	await Promise.all([firstRejected, second]);
	assert.deepEqual(order, ["start", "start", "finish"]);
	assert.equal(c.sessionSaveQueues.size, 0);
});

test("regeneration replaces the intended turn without duplicating its user message", async () => {
	const { state, session, send } = chatRig();
	session.data.messages = [
		{ role: "user", messageID: "u1", content: "Old question" },
		{ role: "assistant", messageID: "a1", content: "Old answer" },
		{ role: "user", messageID: "u2", content: "Follow-up" }
	];
	await send("Revised question", { replaceFromMessageID: "a1", regenerateExistingUser: true });
	assert.deepEqual(state.currentSession.data.messages.map((message) => message.content), ["Revised question", "Answer"]);
});

function sourceRef(id, text) {
	return { sourceID: id, label: id, resolutionKind: "pdf", parser: "test", textSnapshot: text };
}

test("many source-heavy turns stay under one global budget without mutating stored messages", () => {
	const { c } = runtime();
	const refs = [0, 1, 2].map((id) => sourceRef("paper-" + id, ("unique-" + id + " ").repeat(5000)));
	const session = { messages: Array.from({ length: 20 }, (_, index) => index % 2
		? { role: "assistant", content: "Answer" }
		: { role: "user", content: "Question " + index, sourceRefs: refs }) };
	const before = clone(session);
	let stats;
	const messages = c.buildChatMessages(session, { onBudget: (value) => { stats = value; } });
	assert(c.getRequestMessagesSize(messages) <= c.REQUEST_LIMIT_CHARS);
	assert(messages.at(-2).content.endsWith("Question 18"));
	assert(messages.at(-2).content.includes("unique-0"));
	assert.equal(messages.filter((message) => message.content.includes("unique-0")).length, 1);
	assert(stats.truncatedSources > 0);
	assert(stats.deduplicatedSources > 0);
	assert.deepEqual(session, before);
});

test("changed snapshots of the same source remain distinct", () => {
	const { c } = runtime();
	const messages = c.buildChatMessages({ messages: [
		{ role: "user", content: "Before", sourceRefs: [sourceRef("same", "Old snapshot")] },
		{ role: "assistant", content: "Answer" },
		{ role: "user", content: "After", sourceRefs: [sourceRef("same", "New snapshot")] }
	] });
	assert(messages[1].content.includes("Old snapshot"));
	assert(messages[3].content.includes("New snapshot"));
});

test("budgeting counts JSON escaping and preserves complete Unicode characters", () => {
	const { c } = runtime();
	c.REQUEST_LIMIT_CHARS = 500;
	const messages = c.buildChatMessages({ messages: [{ role: "user", content: "Keep my exact question",
		sourceRefs: [sourceRef("unicode", '\\"\n😀中文'.repeat(300))] }] });
	assert(JSON.stringify(messages).length <= 500);
	assert(messages.at(-1).content.endsWith("Keep my exact question"));
	assert(messages.at(-1).content.includes("[truncated]"));
	const excerpt = messages.at(-1).content.split("\n...[truncated]")[0];
	assert(!/[\uD800-\uDBFF]$/.test(excerpt));
});

test("oversized history is removed by complete turns while the newest question is preserved", () => {
	const { c } = runtime();
	c.REQUEST_LIMIT_CHARS = 300;
	const messages = c.buildChatMessages({ messages: [
		{ role: "user", content: "x".repeat(200) }, { role: "assistant", content: "y".repeat(200) },
		{ role: "user", content: "Newest question" }
	] });
	assert.deepEqual(Array.from(messages, (message) => message.role), ["system", "user"]);
	assert.equal(messages[1].content, "Newest question");
});

test("an oversized current question is rejected rather than silently truncated", () => {
	const { c } = runtime();
	c.REQUEST_LIMIT_CHARS = 200;
	assert.throws(() => c.buildChatMessages({ messages: [{ role: "user", content: "x".repeat(500) }] }), /上下文上限/);
});

test("tool results cannot cause a subsequent oversized outbound request", async () => {
	const { c, scope } = runtime();
	c.REQUEST_LIMIT_CHARS = 400;
	c.buildEnabledToolDefinitions = () => [{ type: "function", function: { name: "test", parameters: {} } }];
	c.runToolCall = async () => ({ ok: true, content: "x".repeat(600) });
	const outbound = [];
	scope.fetch = async (_url, options) => {
		outbound.push(JSON.parse(options.body));
		return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: "", tool_calls: [
			{ id: "call1", type: "function", function: { name: "test", arguments: "{}" } }
		] } }] }) };
	};
	await assert.rejects(c.requestMessagesCompletionWithTools({ llm, messages: [{ role: "user", content: "Question" }] }), /上下文上限/);
	assert.equal(outbound.length, 1);
	assert(outbound.every((payload) => JSON.stringify(payload.messages).length <= c.REQUEST_LIMIT_CHARS));
});

test("stopping during a tool prevents follow-up requests without AbortController", async () => {
	const { c } = runtime({ abortController: false });
	const state = { activeRequestID: "first", stopRequested: false };
	const tool = deferred(), started = deferred();
	let requests = 0;
	c.buildEnabledToolDefinitions = () => [{ type: "function", function: { name: "test" } }];
	c.requestChatCompletionJSON = async () => {
		requests++;
		return { choices: [{ message: { tool_calls: [{ id: "call", function: { name: "test", arguments: "{}" } }] } }] };
	};
	c.runToolCall = async () => { started.resolve(); return tool.promise; };
	const request = c.requestMessagesCompletionWithTools({ llm, messages: [{ role: "user", content: "Q" }], state });
	const rejected = assert.rejects(request, { name: "AbortError" });
	await started.promise;
	state.activeRequestID = "second";
	tool.resolve({ ok: true });
	await rejected;
	assert.equal(requests, 1);
});

function mockStream(scope, chunks) {
	let reads = 0, released = false, cancelled = false;
	const reader = { async read() { return reads < chunks.length ? { done: false, value: chunks[reads++] } : { done: true }; },
		releaseLock() { released = true; }, async cancel() { cancelled = true; } };
	scope.fetch = async () => ({ ok: true, headers: { get: () => "text/event-stream" }, body: { getReader: () => reader } });
	return { reader, reads: () => reads, released: () => released, cancelled: () => cancelled };
}

test("streaming handles split UTF-8, CRLF, and an unterminated final data line", async () => {
	const { c, scope } = runtime();
	const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"中文😀"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"尾段"}}]}');
	const stream = mockStream(scope, Array.from(bytes, (byte) => Uint8Array.of(byte)));
	const deltas = [], readers = [];
	const result = await c.requestChatCompletionStream({ endpoint: "mock", apiKey: "test", payload: { messages: [] },
		onDelta: (delta) => deltas.push(delta.text), onReader: (reader) => readers.push(reader) });
	assert.equal(result, "中文😀尾段");
	assert.deepEqual(deltas, ["中文😀", "尾段"]);
	assert.equal(stream.released(), true);
	assert.equal(readers.at(-1), null);
});

test("DONE ends a stream without waiting for the server to close the connection", async () => {
	const { c, scope } = runtime();
	const encoder = new TextEncoder();
	const stream = mockStream(scope, [encoder.encode('data: {"choices":[{"delta":{"content":"Done"}}]}\n\ndata: [DONE]\n\n'), encoder.encode("should not read")]);
	assert.equal(await c.requestChatCompletionStream({ endpoint: "mock", apiKey: "test", payload: { messages: [] } }), "Done");
	assert.equal(stream.reads(), 1);
	assert.equal(stream.cancelled(), true);
});

test("cancellation never falls back to a second request", async () => {
	const { c } = runtime();
	let fallbacks = 0;
	c.requestChatCompletionStream = async () => { throw new DOMException("Aborted", "AbortError"); };
	c.requestChatCompletionNonStream = async () => { fallbacks++; };
	await assert.rejects(c.requestMessagesCompletion({ llm, messages: [{ role: "user", content: "Q" }] }), { name: "AbortError" });
	assert.equal(fallbacks, 0);
});

test("unsupported streaming falls back once, but failure after a delta does not repeat the request", async () => {
	for (const partial of [false, true]) {
		const { c } = runtime();
		let fallbacks = 0;
		c.requestChatCompletionStream = async ({ onDelta }) => {
			if (partial) onDelta({ type: "content", text: "Partial" });
			throw new Error("stream unavailable");
		};
		c.requestChatCompletionNonStream = async () => { fallbacks++; return "Fallback"; };
		const request = c.requestMessagesCompletion({ llm, messages: [{ role: "user", content: "Q" }] });
		if (partial) await assert.rejects(request, /stream unavailable/);
		else assert.equal(await request, "Fallback");
		assert.equal(fallbacks, partial ? 0 : 1);
	}
});
