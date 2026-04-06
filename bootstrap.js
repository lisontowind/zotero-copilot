var ZoteroCopilot;
var ZoteroCopilotKaTeX;
var ZoteroCopilotMarked;

function log(msg) {
	Zotero.debug("Zotero Copilot: " + msg);
}

function resolveKatexRuntime(scope) {
	let candidates = [
		scope,
		scope?.default,
		scope?.katex,
		scope?.default?.katex,
		scope?.module?.exports,
		scope?.module?.exports?.default,
		scope?.module?.exports?.katex,
		scope?.exports,
		scope?.exports?.default,
		scope?.exports?.katex,
		globalThis.ZoteroCopilotKaTeX,
		globalThis.katex
	];
	for (let candidate of candidates) {
		if (candidate?.renderToString || candidate?.render) {
			return candidate;
		}
	}
	return null;
}

function install() {
	log("Installed 0.2.77");
}

async function startup({ id, version, rootURI }) {
	log("Starting " + version);
	await Zotero.initializationPromise;

	try {
		let katexScope = {
			module: { exports: {} },
			exports: {}
		};
		Services.scriptloader.loadSubScript(rootURI + "vendor/katex/katex.min.js", katexScope);
		ZoteroCopilotKaTeX = resolveKatexRuntime(katexScope);
		globalThis.ZoteroCopilotKaTeX = ZoteroCopilotKaTeX;
	}
	catch (e) {
		log(`KaTeX load failed: ${e}`);
		Zotero.logError(e);
	}

	try {
		let markedScope = {
			module: { exports: {} },
			exports: {}
		};
		Services.scriptloader.loadSubScript(rootURI + "vendor/marked/marked.umd.js", markedScope);
		ZoteroCopilotMarked = markedScope.module?.exports?.marked
			|| markedScope.exports?.marked
			|| markedScope.marked
			|| globalThis.marked
			|| null;
		globalThis.ZoteroCopilotMarked = ZoteroCopilotMarked;
	}
	catch (e) {
		log(`Marked load failed: ${e}`);
		Zotero.logError(e);
	}

	try {
		let prefPaneCandidates = [
			{
				id: "zotero-copilot-prefpane",
				pluginID: id,
				src: rootURI + "preferences.xhtml",
				scripts: [rootURI + "preferences.js"],
				stylesheets: [rootURI + "preferences.css"],
				label: "Copilot",
				image: rootURI + "icon.svg"
			},
			{
				id: "zotero-copilot-prefpane",
				pluginID: id,
				src: "preferences.xhtml",
				scripts: [rootURI + "preferences.js"],
				stylesheets: [rootURI + "preferences.css"],
				label: "Copilot",
				image: "icon.svg"
			},
			{
				id: "zotero-copilot-prefpane",
				pluginID: id,
				src: "preferences.xhtml",
				label: "Copilot",
				image: "icon.svg"
			}
		];
		let prefRegistered = false;
		for (let options of prefPaneCandidates) {
			try {
				Zotero.PreferencePanes.register(options);
				prefRegistered = true;
				break;
			}
			catch (e) {
				log(`Preference pane registration attempt failed: ${e}`);
			}
		}
		if (!prefRegistered) {
			throw new Error("All preference pane registration attempts failed");
		}
	}
	catch (e) {
		log(`Preference pane registration failed: ${e}`);
		Zotero.logError(e);
	}

	Services.scriptloader.loadSubScript(rootURI + "copilot.js");
	ZoteroCopilot.init({ id, version, rootURI });
	ZoteroCopilot.addToAllWindows();
	await ZoteroCopilot.main();
}

function onMainWindowLoad({ window }) {
	ZoteroCopilot?.addToWindow(window);
}

function onMainWindowUnload({ window }) {
	ZoteroCopilot?.removeFromWindow(window);
}

function shutdown() {
	log("Shutting down 0.2.77");
	ZoteroCopilot.removeFromAllWindows();
	ZoteroCopilot = undefined;
	ZoteroCopilotKaTeX = undefined;
	ZoteroCopilotMarked = undefined;
	delete globalThis.ZoteroCopilotKaTeX;
	delete globalThis.ZoteroCopilotMarked;
}

function uninstall() {
	log("Uninstalled 0.2.77");
}
