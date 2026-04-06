var ZoteroCopilotPreferences = {
	PREF_BRANCH: "extensions.zotero-copilot.",
	HTML_NS: "http://www.w3.org/1999/xhtml",
	initialized: false,
	currentProviderID: "",
	currentModelID: "",
	currentPromptID: "",
	modelPickerProviderID: "",
	modelPickerSearchTerm: "",
	DEFAULT_SYSTEM_PROMPT_NAME: "默认学术助手",
	DEFAULT_SYSTEM_PROMPT_CONTENT: "You are Zotero Copilot, an academic research assistant embedded in Zotero. Use the provided source context snapshots when relevant. If context is insufficient, say so explicitly. Respond in the user's language unless asked otherwise.",

	PROVIDER_FIELDS: [
		{ id: "copilot-provider-name", key: "name" },
		{ id: "copilot-provider-api-base-url", key: "apiBaseURL" },
		{ id: "copilot-provider-api-key", key: "apiKey" },
		{ id: "copilot-provider-models-path", key: "modelsPath" },
		{ id: "copilot-provider-chat-path", key: "chatPath" }
	],

	MODEL_FIELDS: [
		{ id: "copilot-model-name", key: "name" },
		{ id: "copilot-model-id", key: "model" },
		{ id: "copilot-model-request-json", key: "requestJSON" }
	],

	PROMPT_FIELDS: [
		{ id: "copilot-system-prompt-name", key: "name" },
		{ id: "copilot-system-prompt-content", key: "content" }
	],

	$(id) {
		return document.getElementById(id);
	},

	createSelectOption(label, value, { disabled = false } = {}) {
		let option = document.createElementNS(this.HTML_NS, "option");
		option.value = String(value || "");
		option.textContent = label;
		option.disabled = !!disabled;
		return option;
	},

	setStatus(message, isError = false) {
		let status = this.$("copilot-status");
		if (!status) return;
		status.textContent = message || "";
		status.style.color = isError ? "#b03232" : "#1d6e36";
	},

	setOutput(message) {
		let output = this.$("copilot-test-output");
		if (!output) return;
		output.textContent = message || "";
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
		if (!extraPayload || typeof extraPayload !== "object") return mergedPayload;
		for (let [key, value] of Object.entries(extraPayload)) {
			if (reservedKeys.includes(key)) {
				throw new Error(`额外 JSON 参数不能覆盖保留字段：${reservedKeys.join(", ")}`);
			}
			mergedPayload[key] = value;
		}
		return mergedPayload;
	},

	resolveAPIEndpoint(baseURL, path = "") {
		let normalizedBase = String(baseURL || "").trim().replace(/\/+$/, "");
		let normalizedPath = String(path || "").trim();
		if (!normalizedBase) return normalizedPath;
		if (!normalizedPath) return normalizedBase;
		if (/^https?:\/\//i.test(normalizedPath)) return normalizedPath;
		return normalizedBase + (normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`);
	},

	getLegacySettings() {
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
		catch (_e) {
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

	makeProviderID() {
		return `provider-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	},

	makeModelID() {
		return `model-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	},

	normalizeProvider(provider, index = 0) {
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

	normalizeModel(model, index = 0) {
		if (!model || typeof model !== "object") return null;
		let id = String(model.id || `model-${index + 1}`).trim() || `model-${index + 1}`;
		return {
			id,
			providerID: String(model.providerID || "").trim(),
			name: String(model.name || model.model || `模型 ${index + 1}`).trim() || `模型 ${index + 1}`,
			model: String(model.model || "").trim(),
			requestJSON: String(model.requestJSON || "").trim()
		};
	},

	makePromptID() {
		return `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	},

	normalizePrompt(prompt, index = 0) {
		if (!prompt || typeof prompt !== "object") return null;
		let id = String(prompt.id || `prompt-${index + 1}`).trim() || `prompt-${index + 1}`;
		let content = String(prompt.content || "").trim();
		return {
			id,
			name: String(prompt.name || `提示词 ${index + 1}`).trim() || `提示词 ${index + 1}`,
			content: content || this.DEFAULT_SYSTEM_PROMPT_CONTENT
		};
	},

	ensurePromptStore() {
		let rawPrompts = this.readJSONPrefArray("systemPromptsJSON");
		let prompts = rawPrompts.map((prompt, index) => this.normalizePrompt(prompt, index)).filter(Boolean);
		if (!prompts.length) {
			prompts = [this.normalizePrompt({
				id: "default-system-prompt",
				name: this.DEFAULT_SYSTEM_PROMPT_NAME,
				content: this.DEFAULT_SYSTEM_PROMPT_CONTENT
			}, 0)];
			this.savePrompts(prompts);
		}
		let activeID = this.getActivePromptID();
		if (!prompts.some((prompt) => prompt.id === activeID) && prompts[0]?.id) {
			this.setActivePromptID(prompts[0].id);
		}
		return prompts;
	},

	ensureNonEmptyStore(providers, models) {
		let normalizedProviders = (providers || []).map((provider, index) => this.normalizeProvider(provider, index)).filter(Boolean);
		let normalizedModels = (models || []).map((model, index) => this.normalizeModel(model, index)).filter(Boolean);
		if (!normalizedProviders.length) {
			normalizedProviders = [this.normalizeProvider({
				id: "default-provider",
				name: "Default Provider",
				apiBaseURL: "",
				apiKey: "",
				modelsPath: "/models",
				chatPath: "/chat/completions"
			}, 0)];
		}
		let providerIDs = new Set(normalizedProviders.map((provider) => provider.id));
		normalizedModels = normalizedModels.filter((model) => providerIDs.has(model.providerID));
		if (!normalizedModels.length) {
			normalizedModels = [this.normalizeModel({
				id: "default-model",
				providerID: normalizedProviders[0].id,
				name: "Default Model",
				model: "",
				requestJSON: ""
			}, 0)];
		}
		return { providers: normalizedProviders, models: normalizedModels };
	},

	migrateLegacyConfig(rawProviders = [], rawModels = []) {
		let providers = (rawProviders || []).map((provider, index) => this.normalizeProvider(provider, index)).filter(Boolean);
		let models = [];
		let providerByLegacyKey = new Map();
		let getOrCreateProvider = (entry, index) => {
			if (String(entry.providerID || "").trim()) {
				let existing = providers.find((provider) => provider.id === entry.providerID);
				if (existing) return existing;
			}
			let apiBaseURL = String(entry.apiBaseURL || "").trim().replace(/\/+$/, "");
			let apiKey = String(entry.apiKey || "").trim().replace(/^Bearer\s+/i, "");
			let legacyKey = `${apiBaseURL}\n${apiKey}`;
			let existing = providerByLegacyKey.get(legacyKey);
			if (existing) return existing;
			let provider = this.normalizeProvider({
				id: this.makeProviderID(),
				name: this.inferProviderName(apiBaseURL, entry.providerName || entry.name || `供应商 ${providers.length + 1}`),
				apiBaseURL,
				apiKey,
				modelsPath: String(entry.modelsPath || "/models").trim() || "/models",
				chatPath: String(entry.chatPath || "/chat/completions").trim() || "/chat/completions"
			}, providers.length);
			if (!provider) return null;
			providers.push(provider);
			providerByLegacyKey.set(legacyKey, provider);
			return provider;
		};
		let entries = Array.isArray(rawModels) ? rawModels : [];
		for (let [index, entry] of entries.entries()) {
			if (!entry || typeof entry !== "object") continue;
			let isNewShape = String(entry.providerID || "").trim() && !("apiBaseURL" in entry) && !("apiKey" in entry);
			if (isNewShape) {
				let normalized = this.normalizeModel(entry, models.length);
				if (normalized) models.push(normalized);
				continue;
			}
			let provider = getOrCreateProvider(entry, index);
			if (!provider) continue;
			let normalized = this.normalizeModel({
				id: String(entry.id || "").trim() || this.makeModelID(),
				providerID: provider.id,
				name: String(entry.name || entry.model || `模型 ${models.length + 1}`).trim(),
				model: String(entry.model || "").trim(),
				requestJSON: String(entry.requestJSON || "").trim()
			}, models.length);
			if (normalized) models.push(normalized);
		}
		if (!providers.length || !models.length) {
			let legacy = this.getLegacySettings();
			providers = [this.normalizeProvider({
				id: "default-provider",
				name: this.inferProviderName(legacy.apiBaseURL, "Default Provider"),
				apiBaseURL: legacy.apiBaseURL,
				apiKey: legacy.apiKey
			}, 0)];
			models = [this.normalizeModel({
				id: "default-model",
				providerID: providers[0].id,
				name: legacy.model || "Default Model",
				model: legacy.model,
				requestJSON: legacy.requestJSON
			}, 0)];
		}
		return this.ensureNonEmptyStore(providers, models);
	},

	ensureConfigStore() {
		let rawProviders = this.readJSONPrefArray("llmProvidersJSON");
		let rawModels = this.readJSONPrefArray("llmProfilesJSON");
		let providers = rawProviders.map((provider, index) => this.normalizeProvider(provider, index)).filter(Boolean);
		let models = rawModels.map((model, index) => this.normalizeModel(model, index)).filter(Boolean);
		let providerIDs = new Set(providers.map((provider) => provider.id));
		let needsMigration = !providers.length
			|| !models.length
			|| rawModels.some((entry) => entry && typeof entry === "object" && (!String(entry.providerID || "").trim() || "apiBaseURL" in entry || "apiKey" in entry))
			|| models.some((model) => !providerIDs.has(model.providerID));
		if (needsMigration) {
			let migrated = this.migrateLegacyConfig(rawProviders, rawModels);
			providers = migrated.providers;
			models = migrated.models;
			let saved = this.saveStore(providers, models);
			providers = saved.providers;
			models = saved.models;
		}
		let activeID = this.getActiveModelID();
		if (!models.some((model) => model.id === activeID) && models[0]?.id) {
			this.setActiveModelID(models[0].id);
		}
		return { providers, models };
	},

	getProviders() {
		return this.ensureConfigStore().providers;
	},

	getModels() {
		return this.ensureConfigStore().models;
	},

	saveProviders(providers) {
		return this.saveStore(providers, this.getModels()).providers;
	},

	saveModels(models) {
		return this.saveStore(this.getProviders(), models).models;
	},

	saveStore(providers, models) {
		let normalized = this.ensureNonEmptyStore(providers, models);
		Zotero.Prefs.set(this.PREF_BRANCH + "llmProvidersJSON", JSON.stringify(normalized.providers, null, 2), true);
		Zotero.Prefs.set(this.PREF_BRANCH + "llmProfilesJSON", JSON.stringify(normalized.models, null, 2), true);
		return normalized;
	},

	getActiveModelID() {
		return String(Zotero.Prefs.get(this.PREF_BRANCH + "activeLLMProfileID", true) || "").trim();
	},

	setActiveModelID(modelID) {
		Zotero.Prefs.set(this.PREF_BRANCH + "activeLLMProfileID", String(modelID || ""), true);
	},

	getTitleModelID() {
		return String(Zotero.Prefs.get(this.PREF_BRANCH + "titleLLMProfileID", true) || "").trim();
	},

	setTitleModelID(modelID) {
		Zotero.Prefs.set(this.PREF_BRANCH + "titleLLMProfileID", String(modelID || ""), true);
	},

	resolveTitleModelID() {
		let storedID = this.getTitleModelID();
		if (!storedID) return "";
		let model = this.getModelByID(storedID);
		if (model) return model.id;
		this.setTitleModelID("");
		return "";
	},

	getPrompts() {
		return this.ensurePromptStore();
	},

	savePrompts(prompts) {
		let normalized = (prompts || []).map((prompt, index) => this.normalizePrompt(prompt, index)).filter(Boolean);
		if (!normalized.length) {
			normalized.push(this.normalizePrompt({
				id: "default-system-prompt",
				name: this.DEFAULT_SYSTEM_PROMPT_NAME,
				content: this.DEFAULT_SYSTEM_PROMPT_CONTENT
			}, 0));
		}
		Zotero.Prefs.set(this.PREF_BRANCH + "systemPromptsJSON", JSON.stringify(normalized, null, 2), true);
		return normalized;
	},

	getActivePromptID() {
		return String(Zotero.Prefs.get(this.PREF_BRANCH + "activeSystemPromptID", true) || "").trim();
	},

	setActivePromptID(promptID) {
		Zotero.Prefs.set(this.PREF_BRANCH + "activeSystemPromptID", String(promptID || ""), true);
	},

	getProviderByID(providerID) {
		return this.getProviders().find((provider) => provider.id === providerID) || null;
	},

	getModelByID(modelID) {
		return this.getModels().find((model) => model.id === modelID) || null;
	},

	getPromptByID(promptID) {
		return this.getPrompts().find((prompt) => prompt.id === promptID) || null;
	},

	getModelDisplayLabel(modelID, { includeProvider = true, showCurrent = false } = {}) {
		let model = typeof modelID === "string" ? this.getModelByID(modelID) : modelID;
		if (!model) return "";
		let provider = this.getProviderByID(model.providerID);
		let label = includeProvider && provider ? `${provider.name} / ${model.name}` : model.name;
		if (showCurrent && model.id === this.getActiveModelID()) {
			label += " (当前聊天)";
		}
		return label;
	},

	updateModelSectionSummary(providerID = "", { draft = false } = {}) {
		let summary = this.$("copilot-model-section-summary");
		if (!summary) return;
		if (draft) {
			summary.textContent = "先保存供应商，再维护该供应商下的模型。";
			return;
		}
		let provider = this.getProviderByID(providerID);
		summary.textContent = provider ? `当前供应商：${provider.name}` : "当前没有可用供应商。";
	},

	getModelsForProvider(providerID = "") {
		let targetProviderID = String(providerID || "").trim();
		if (!targetProviderID) return [];
		return this.getModels().filter((model) => model.providerID === targetProviderID);
	},

	getPreferredModelForProvider(providerID = "", preferredModelID = "") {
		let models = this.getModelsForProvider(providerID);
		let candidates = [
			preferredModelID,
			this.currentModelID,
			this.getActiveModelID(),
			models[0]?.id || ""
		].filter(Boolean);
		for (let candidate of candidates) {
			let found = models.find((model) => model.id === candidate);
			if (found) return found;
		}
		return null;
	},

	renderProviderSelect(targetID = "") {
		let select = this.$("copilot-provider-select");
		if (!select) return;
		let providers = this.getProviders();
		select.textContent = "";
		for (let provider of providers) {
			select.appendChild(this.createSelectOption(provider.name, provider.id));
		}
		let chosen = targetID || this.currentProviderID || providers[0]?.id || "";
		select.value = chosen;
		this.currentProviderID = String(select.value || chosen || "");
	},

	renderModelSelect(targetID = "") {
		let select = this.$("copilot-model-select");
		if (!select) return;
		let providerID = String(this.currentProviderID || this.$("copilot-provider-select")?.value || "").trim();
		let models = this.getModelsForProvider(providerID);
		let activeID = this.getActiveModelID();
		select.textContent = "";
		for (let model of models) {
			let label = `${model.name}${model.id === activeID ? " (当前)" : ""}`;
			select.appendChild(this.createSelectOption(label, model.id));
		}
		let chosen = this.getPreferredModelForProvider(providerID, targetID)?.id || "";
		select.value = chosen;
		select.disabled = !models.length;
		this.currentModelID = String(select.value || chosen || "");
	},

	syncTitleModelControls() {
		try {
			this.renderTitleModelSelect();
		}
		catch (e) {
			console.error?.("Zotero Copilot title model select sync failed", e);
			this.setStatus("自动命名模型设置加载失败，但不会影响聊天模型设置", true);
		}
	},

	updateTitleModelSummary() {
		let summary = this.$("copilot-title-model-summary");
		if (!summary) return;
		let selectedID = this.resolveTitleModelID();
		if (!selectedID) {
			let activeLabel = this.getModelDisplayLabel(this.getActiveModelID(), { includeProvider: true, showCurrent: false });
			summary.textContent = activeLabel ? `当前跟随聊天模型：${activeLabel}` : "当前跟随聊天模型。";
			return;
		}
		let label = this.getModelDisplayLabel(selectedID, { includeProvider: true, showCurrent: false });
		summary.textContent = label ? `当前自动命名模型：${label}` : "当前没有可用的自动命名模型。";
	},

	renderTitleModelSelect() {
		let select = this.$("copilot-title-model-select");
		if (!select) return;
		let models = this.getModels();
		let selectedID = this.resolveTitleModelID();
		let followLabel = this.getModelDisplayLabel(this.getActiveModelID(), { includeProvider: true, showCurrent: false });
		select.textContent = "";
		select.appendChild(this.createSelectOption(
			followLabel ? `跟随当前聊天模型（${followLabel}）` : "跟随当前聊天模型",
			""
		));
		for (let model of models) {
			select.appendChild(this.createSelectOption(
				this.getModelDisplayLabel(model, { includeProvider: true, showCurrent: true }),
				model.id
			));
		}
		select.value = selectedID;
		select.disabled = !models.length;
		this.updateTitleModelSummary();
	},

	updatePromptSummary() {
		let summary = this.$("copilot-system-prompt-summary");
		if (!summary) return;
		let prompt = this.getPromptByID(this.getActivePromptID()) || this.getPrompts()[0] || null;
		summary.textContent = prompt ? `当前系统提示词：${prompt.name}` : "当前没有可用的系统提示词。";
	},

	renderPromptSelect(targetID = "") {
		let select = this.$("copilot-system-prompt-select");
		if (!select) return;
		let prompts = this.getPrompts();
		let activeID = this.getActivePromptID();
		select.textContent = "";
		for (let prompt of prompts) {
			let label = `${prompt.name}${prompt.id === activeID ? " (当前)" : ""}`;
			select.appendChild(this.createSelectOption(label, prompt.id));
		}
		let chosen = targetID || this.currentPromptID || activeID || prompts[0]?.id || "";
		select.value = chosen;
		select.disabled = !prompts.length;
		this.currentPromptID = String(select.value || chosen || "");
		this.updatePromptSummary();
	},

	loadProviderIntoForm(providerID) {
		let provider = this.getProviderByID(providerID) || this.getProviders()[0] || null;
		if (!provider) return;
		this.currentProviderID = provider.id;
		for (let field of this.PROVIDER_FIELDS) {
			let input = this.$(field.id);
			if (input) input.value = String(provider[field.key] || "");
		}
		this.renderProviderSelect(provider.id);
		this.updateModelSectionSummary(provider.id);
		let preferredModel = this.getPreferredModelForProvider(provider.id);
		if (preferredModel) this.loadModelIntoForm(preferredModel.id);
		else this.clearModelFormForNew(provider.id, { silent: true });
		this.syncTitleModelControls();
		this.setStatus("");
	},

	clearProviderFormForNew() {
		this.currentProviderID = "";
		for (let field of this.PROVIDER_FIELDS) {
			let input = this.$(field.id);
			if (!input) continue;
			input.value = field.key === "modelsPath" ? "/models" : (field.key === "chatPath" ? "/chat/completions" : "");
		}
		let select = this.$("copilot-provider-select");
		if (select) select.value = "";
		this.updateModelSectionSummary("", { draft: true });
		this.renderModelSelect("");
		this.syncTitleModelControls();
		this.setStatus("已切换到新供应商草稿");
	},

	readProviderForm() {
		let provider = {};
		for (let field of this.PROVIDER_FIELDS) {
			let input = this.$(field.id);
			provider[field.key] = String(input?.value || "").trim();
		}
		provider.apiBaseURL = provider.apiBaseURL.replace(/\/+$/, "");
		provider.apiKey = provider.apiKey.replace(/^Bearer\s+/i, "");
		provider.modelsPath = provider.modelsPath || "/models";
		provider.chatPath = provider.chatPath || "/chat/completions";
		provider.name = provider.name || this.inferProviderName(provider.apiBaseURL, "未命名供应商");
		return provider;
	},

	saveCurrentProvider({ silent = false } = {}) {
		let provider = this.readProviderForm();
		let store = this.ensureConfigStore();
		let providerID = this.currentProviderID || this.makeProviderID();
		let nextProvider = this.normalizeProvider({ ...provider, id: providerID }, store.providers.length);
		let index = store.providers.findIndex((entry) => entry.id === providerID);
		if (index >= 0) store.providers[index] = nextProvider;
		else store.providers.unshift(nextProvider);
		let saved = this.saveStore(store.providers, store.models);
		this.currentProviderID = nextProvider.id;
		this.loadProviderIntoForm(nextProvider.id);
		if (!silent) this.setStatus(`已保存供应商：${nextProvider.name}`);
		return saved.providers.find((entry) => entry.id === nextProvider.id) || nextProvider;
	},

	deleteCurrentProvider() {
		let providerID = this.currentProviderID || this.$("copilot-provider-select")?.value || "";
		if (!providerID) {
			this.setStatus("没有可删除的供应商", true);
			return;
		}
		let store = this.ensureConfigStore();
		let provider = store.providers.find((entry) => entry.id === providerID);
		if (!provider) {
			this.setStatus("供应商不存在", true);
			return;
		}
		let linkedModels = store.models.filter((model) => model.providerID === providerID);
		let confirmed = window.confirm(`确定删除供应商“${provider.name}”吗？会同时删除其下 ${linkedModels.length} 个模型配置。`);
		if (!confirmed) return;
		store.providers = store.providers.filter((entry) => entry.id !== providerID);
		store.models = store.models.filter((entry) => entry.providerID !== providerID);
		let saved = this.saveStore(store.providers, store.models);
		if (linkedModels.some((model) => model.id === this.getActiveModelID())) {
			this.setActiveModelID(saved.models[0]?.id || "");
		}
		this.loadProviderIntoForm(saved.providers[0]?.id || "");
		this.loadModelIntoForm(saved.models[0]?.id || "");
		this.setStatus("已删除供应商");
	},

	loadModelIntoForm(modelID) {
		let store = this.ensureConfigStore();
		let model = store.models.find((entry) => entry.id === modelID) || store.models[0] || null;
		if (!model) return;
		this.currentModelID = model.id;
		for (let field of this.MODEL_FIELDS) {
			let input = this.$(field.id);
			if (input) input.value = String(model[field.key] || "");
		}
		this.currentProviderID = String(model.providerID || this.currentProviderID || "").trim();
		this.renderProviderSelect(this.currentProviderID);
		this.updateModelSectionSummary(this.currentProviderID);
		this.renderModelSelect(model.id);
		this.syncTitleModelControls();
		this.setStatus("");
	},

	loadPromptIntoForm(promptID) {
		let prompts = this.getPrompts();
		let prompt = prompts.find((entry) => entry.id === promptID) || prompts[0] || null;
		if (!prompt) return;
		this.currentPromptID = prompt.id;
		for (let field of this.PROMPT_FIELDS) {
			let input = this.$(field.id);
			if (input) input.value = String(prompt[field.key] || "");
		}
		this.renderPromptSelect(prompt.id);
		this.setStatus("");
	},

	clearPromptFormForNew({ silent = false } = {}) {
		this.currentPromptID = "";
		for (let field of this.PROMPT_FIELDS) {
			let input = this.$(field.id);
			if (input) input.value = "";
		}
		let select = this.$("copilot-system-prompt-select");
		if (select) select.value = "";
		this.renderPromptSelect("");
		if (!silent) this.setStatus("已切换到新提示词草稿");
	},

	clearModelFormForNew(providerID = "", { silent = false } = {}) {
		let resolvedProviderID = String(providerID || this.currentProviderID || "").trim();
		this.currentProviderID = resolvedProviderID;
		this.currentModelID = "";
		for (let field of this.MODEL_FIELDS) {
			let input = this.$(field.id);
			if (!input) continue;
			input.value = "";
		}
		let select = this.$("copilot-model-select");
		if (select) select.value = "";
		this.renderProviderSelect(resolvedProviderID);
		this.updateModelSectionSummary(resolvedProviderID, { draft: !resolvedProviderID });
		this.renderModelSelect("");
		this.syncTitleModelControls();
		if (!silent) this.setStatus("已切换到新模型草稿");
	},

	readModelForm() {
		let model = {};
		for (let field of this.MODEL_FIELDS) {
			let input = this.$(field.id);
			model[field.key] = String(input?.value || "").trim();
		}
		model.providerID = String(this.currentProviderID || "").trim();
		this.parseOptionalJSONObject(model.requestJSON, "模型额外 JSON 参数");
		model.name = model.name || model.model || "未命名模型";
		if (!model.providerID) {
			throw new Error("请先保存并选中供应商");
		}
		return model;
	},

	saveCurrentModel({ silent = false } = {}) {
		let model;
		try {
			model = this.readModelForm();
		}
		catch (e) {
			if (!silent) this.setStatus(e.message || String(e), true);
			return null;
		}
		let store = this.ensureConfigStore();
		let modelID = this.currentModelID || this.makeModelID();
		let nextModel = this.normalizeModel({ ...model, id: modelID }, store.models.length);
		let index = store.models.findIndex((entry) => entry.id === modelID);
		if (index >= 0) store.models[index] = nextModel;
		else store.models.unshift(nextModel);
		let saved = this.saveStore(store.providers, store.models);
		this.currentModelID = nextModel.id;
		this.renderModelSelect(nextModel.id);
		this.syncTitleModelControls();
		this.updateModelSectionSummary(nextModel.providerID);
		if (!silent) this.setStatus(`已保存模型：${nextModel.name}`);
		return saved.models.find((entry) => entry.id === nextModel.id) || nextModel;
	},

	deleteCurrentModel() {
		let modelID = this.currentModelID || this.$("copilot-model-select")?.value || "";
		if (!modelID) {
			this.setStatus("没有可删除的模型", true);
			return;
		}
		let store = this.ensureConfigStore();
		let model = store.models.find((entry) => entry.id === modelID);
		if (!model) {
			this.setStatus("模型不存在", true);
			return;
		}
		let confirmed = window.confirm(`确定删除模型“${model.name}”吗？`);
		if (!confirmed) return;
		store.models = store.models.filter((entry) => entry.id !== modelID);
		let saved = this.saveStore(store.providers, store.models);
		if (this.getActiveModelID() === modelID) {
			this.setActiveModelID(saved.models[0]?.id || "");
		}
		if (this.getTitleModelID() === modelID) {
			this.setTitleModelID("");
		}
		this.loadModelIntoForm(saved.models[0]?.id || "");
		this.syncTitleModelControls();
		this.setStatus("已删除模型");
	},

	setCurrentModelActive() {
		let savedModel = this.saveCurrentModel({ silent: true });
		if (!savedModel) return;
		this.setActiveModelID(savedModel.id);
		this.renderModelSelect(savedModel.id);
		this.syncTitleModelControls();
		this.setStatus(`已设为当前模型：${savedModel.name}`);
	},

	setCurrentTitleModel(modelID) {
		let nextID = String(modelID || "").trim();
		if (!nextID) {
			this.setTitleModelID("");
			this.syncTitleModelControls();
			this.setStatus("会话自动命名将跟随当前聊天模型");
			return;
		}
		let model = this.getModelByID(nextID);
		if (!model) {
			this.setStatus("自动命名模型不存在", true);
			this.syncTitleModelControls();
			return;
		}
		this.setTitleModelID(model.id);
		this.syncTitleModelControls();
		this.setStatus(`已设置自动命名模型：${this.getModelDisplayLabel(model, { includeProvider: true, showCurrent: false })}`);
	},

	readPromptForm() {
		let prompt = {};
		for (let field of this.PROMPT_FIELDS) {
			let input = this.$(field.id);
			prompt[field.key] = String(input?.value || "").trim();
		}
		prompt.name = prompt.name || "未命名提示词";
		prompt.content = prompt.content || this.DEFAULT_SYSTEM_PROMPT_CONTENT;
		return prompt;
	},

	saveCurrentPrompt({ silent = false } = {}) {
		let prompt = this.readPromptForm();
		let prompts = this.getPrompts();
		let promptID = this.currentPromptID || this.makePromptID();
		let nextPrompt = this.normalizePrompt({ ...prompt, id: promptID }, prompts.length);
		let index = prompts.findIndex((entry) => entry.id === promptID);
		if (index >= 0) prompts[index] = nextPrompt;
		else prompts.unshift(nextPrompt);
		let saved = this.savePrompts(prompts);
		this.currentPromptID = nextPrompt.id;
		this.renderPromptSelect(nextPrompt.id);
		if (!silent) this.setStatus(`已保存系统提示词：${nextPrompt.name}`);
		return saved.find((entry) => entry.id === nextPrompt.id) || nextPrompt;
	},

	deleteCurrentPrompt() {
		let promptID = this.currentPromptID || this.$("copilot-system-prompt-select")?.value || "";
		if (!promptID) {
			this.setStatus("没有可删除的系统提示词", true);
			return;
		}
		let prompts = this.getPrompts();
		let prompt = prompts.find((entry) => entry.id === promptID);
		if (!prompt) {
			this.setStatus("系统提示词不存在", true);
			return;
		}
		let confirmed = window.confirm(`确定删除系统提示词“${prompt.name}”吗？`);
		if (!confirmed) return;
		let saved = this.savePrompts(prompts.filter((entry) => entry.id !== promptID));
		if (this.getActivePromptID() === promptID) {
			this.setActivePromptID(saved[0]?.id || "");
		}
		this.loadPromptIntoForm(saved[0]?.id || "");
		this.setStatus("已删除系统提示词");
	},

	setCurrentPromptActive() {
		let savedPrompt = this.saveCurrentPrompt({ silent: true });
		if (!savedPrompt) return;
		this.setActivePromptID(savedPrompt.id);
		this.renderPromptSelect(savedPrompt.id);
		this.setStatus(`已设为当前系统提示词：${savedPrompt.name}`);
	},

	readCurrentMergedSettings() {
		let provider = this.readProviderForm();
		let model = this.readModelForm();
		return {
			apiBaseURL: provider.apiBaseURL,
			apiKey: provider.apiKey,
			model: model.model,
			requestJSON: model.requestJSON,
			chatPath: provider.chatPath
		};
	},

	extractModelIDs(payload) {
		let candidates = [];
		if (Array.isArray(payload)) candidates = payload;
		else if (Array.isArray(payload?.data)) candidates = payload.data;
		else if (Array.isArray(payload?.models)) candidates = payload.models;
		else if (Array.isArray(payload?.items)) candidates = payload.items;
		let values = candidates.map((entry) => {
			if (typeof entry === "string") return entry;
			return String(entry?.id || entry?.name || entry?.model || "").trim();
		}).filter(Boolean);
		return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
	},

	async fetchAvailableProviderModels(provider) {
		let endpoint = this.resolveAPIEndpoint(provider.apiBaseURL, provider.modelsPath || "/models");
		if (!provider.apiBaseURL || !provider.apiKey) {
			throw new Error("请先填写供应商 API Base URL 和 API Key");
		}
		let response = await fetch(endpoint, {
			method: "GET",
			headers: {
				"Accept": "application/json",
				"Authorization": "Bearer " + provider.apiKey
			}
		});
		let text = await response.text();
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}\n${text.slice(0, 800)}`);
		}
		let parsed;
		try {
			parsed = JSON.parse(text);
		}
		catch (e) {
			throw new Error(`模型列表返回了无法解析的 JSON：${e.message || e}`);
		}
		return this.extractModelIDs(parsed);
	},

	renderModelPicker(modelIDs, providerName) {
		let dialog = this.$("copilot-model-picker");
		let list = this.$("copilot-model-picker-list");
		let empty = this.$("copilot-model-picker-empty");
		let summary = this.$("copilot-model-picker-summary");
		let search = this.$("copilot-model-picker-search");
		if (!dialog || !list || !empty || !summary || !search) return;
		list.textContent = "";
		summary.textContent = `供应商：${providerName}`;
		search.value = "";
		this.modelPickerSearchTerm = "";
		if (!modelIDs.length) {
			search.disabled = true;
			empty.textContent = "没有可添加的新模型。已存在的模型会被自动忽略。";
			dialog.hidden = false;
			return;
		}
		search.disabled = false;
		empty.textContent = "";
		for (let modelID of modelIDs) {
			let row = document.createElementNS(this.HTML_NS, "label");
			row.setAttribute("class", "copilot-model-picker-item");
			row.dataset.modelId = modelID.toLowerCase();
			let input = document.createElementNS(this.HTML_NS, "input");
			input.setAttribute("type", "checkbox");
			input.setAttribute("value", modelID);
			let text = document.createElementNS(this.HTML_NS, "span");
			text.textContent = modelID;
			row.appendChild(input);
			row.appendChild(text);
			list.appendChild(row);
		}
		dialog.hidden = false;
		search.focus();
		this.filterModelPickerList("");
	},

	filterModelPickerList(rawQuery = "") {
		let list = this.$("copilot-model-picker-list");
		let empty = this.$("copilot-model-picker-empty");
		if (!list || !empty) return;
		let query = String(rawQuery || "").trim().toLowerCase();
		let terms = query ? query.split(/\s+/).filter(Boolean) : [];
		this.modelPickerSearchTerm = query;
		let items = Array.from(list.querySelectorAll(".copilot-model-picker-item"));
		let visibleCount = 0;
		for (let item of items) {
			let haystack = String(item.dataset.modelId || "");
			let matches = !terms.length || terms.every((term) => haystack.includes(term));
			item.style.display = matches ? "" : "none";
			if (matches) visibleCount += 1;
		}
		if (!items.length) {
			empty.textContent = "没有可添加的新模型。已存在的模型会被自动忽略。";
			return;
		}
		empty.textContent = visibleCount ? "" : `没有匹配 “${rawQuery}” 的模型。`;
	},

	closeModelPicker() {
		let dialog = this.$("copilot-model-picker");
		if (dialog) dialog.hidden = true;
		let search = this.$("copilot-model-picker-search");
		if (search) {
			search.value = "";
			search.disabled = false;
		}
		this.filterModelPickerList("");
		this.modelPickerProviderID = "";
		this.modelPickerSearchTerm = "";
	},

	async openFetchModelsDialog() {
		let provider = this.saveCurrentProvider({ silent: true });
		if (!provider) {
			this.setStatus("请先保存供应商配置", true);
			return;
		}
		this.setStatus("正在获取模型列表...");
		try {
			let fetchedModels = await this.fetchAvailableProviderModels(provider);
			let existing = new Set(this.getModels().filter((model) => model.providerID === provider.id).map((model) => model.model));
			let filtered = fetchedModels.filter((modelID) => !existing.has(modelID));
			this.modelPickerProviderID = provider.id;
			this.renderModelPicker(filtered, provider.name);
			this.setStatus(filtered.length ? `获取到 ${filtered.length} 个可添加模型` : "没有可添加的新模型");
		}
		catch (e) {
			this.setStatus(`获取模型失败：${e.message || e}`, true);
		}
	},

	addSelectedModels() {
		let providerID = this.modelPickerProviderID;
		if (!providerID) {
			this.setStatus("当前没有可添加的供应商模型", true);
			return;
		}
		let checkboxes = Array.from(document.querySelectorAll("#copilot-model-picker-list input[type='checkbox']:checked"));
		if (!checkboxes.length) {
			this.setStatus("请先选择要添加的模型", true);
			return;
		}
		let store = this.ensureConfigStore();
		for (let input of checkboxes) {
			let modelID = String(input.value || "").trim();
			if (!modelID || store.models.some((model) => model.providerID === providerID && model.model === modelID)) {
				continue;
			}
			store.models.unshift(this.normalizeModel({
				id: this.makeModelID(),
				providerID,
				name: modelID,
				model: modelID,
				requestJSON: ""
			}, store.models.length));
		}
		let saved = this.saveStore(store.providers, store.models);
		let firstAdded = saved.models.find((model) => model.providerID === providerID) || saved.models[0] || null;
		this.closeModelPicker();
		if (firstAdded) {
			this.loadModelIntoForm(firstAdded.id);
		}
		this.syncTitleModelControls();
		this.setStatus("已添加所选模型");
	},

	async testConnection() {
		let llm;
		try {
			llm = this.readCurrentMergedSettings();
		}
		catch (e) {
			this.setStatus(e.message || String(e), true);
			return;
		}
		if (!llm.apiBaseURL || !llm.apiKey || !llm.model) {
			this.setStatus("测试失败：请先填写供应商 API Base URL、API Key 和模型名", true);
			return;
		}
		let extraParams;
		try {
			extraParams = this.parseOptionalJSONObject(llm.requestJSON, "模型额外 JSON 参数");
		}
		catch (e) {
			this.setStatus(e.message || String(e), true);
			return;
		}
		let endpoint = this.resolveAPIEndpoint(llm.apiBaseURL, llm.chatPath || "/chat/completions");
		let payload = this.mergeRequestPayload(
			{
				model: llm.model,
				messages: [
					{ role: "system", content: "Reply with exactly OK." },
					{ role: "user", content: "ping" }
				]
			},
			extraParams,
			["model", "messages"]
		);
		let controller = new AbortController();
		let timeoutID = setTimeout(() => controller.abort(), 30000);
		try {
			this.setStatus("正在测试 LLM 连接...");
			this.setOutput(`POST ${endpoint}\nmodel=${llm.model}`);
			let response = await fetch(endpoint, {
				method: "POST",
				headers: {
					"Accept": "application/json",
					"Content-Type": "application/json",
					"Authorization": "Bearer " + llm.apiKey
				},
				body: JSON.stringify(payload),
				signal: controller.signal
			});
			let text = await response.text();
			if (!response.ok) {
				this.setStatus(`测试失败：HTTP ${response.status}`, true);
				this.setOutput(text.slice(0, 2000));
				return;
			}
			this.setStatus("LLM 连接成功");
			this.setOutput(text.slice(0, 2000));
		}
		catch (e) {
			let msg = e?.name === "AbortError" ? "请求超时" : (e.message || String(e));
			this.setStatus("测试失败：" + msg, true);
			this.setOutput(msg);
		}
		finally {
			clearTimeout(timeoutID);
		}
	},

	init() {
		if (this.initialized) return;
		this.initialized = true;
		let store = this.ensureConfigStore();
		let initialModelID = this.getActiveModelID() || store.models[0]?.id || "";
		let initialModel = this.getModelByID(initialModelID);
		let initialProviderID = initialModel?.providerID || store.providers[0]?.id || "";
		let initialPromptID = this.getActivePromptID() || this.getPrompts()[0]?.id || "";
		this.renderProviderSelect(initialProviderID);
		this.updateModelSectionSummary(initialProviderID);
		this.renderModelSelect(initialModelID);
		this.renderPromptSelect(initialPromptID);
		this.loadProviderIntoForm(this.$("copilot-provider-select")?.value || initialProviderID);
		this.loadModelIntoForm(this.$("copilot-model-select")?.value || initialModelID);
		this.loadPromptIntoForm(this.$("copilot-system-prompt-select")?.value || initialPromptID);
		this.syncTitleModelControls();
		let providerSelect = this.$("copilot-provider-select");
		let modelSelect = this.$("copilot-model-select");
		let titleModelSelect = this.$("copilot-title-model-select");
		let promptSelect = this.$("copilot-system-prompt-select");
		providerSelect?.addEventListener("change", () => this.loadProviderIntoForm(providerSelect.value));
		modelSelect?.addEventListener("change", () => this.loadModelIntoForm(modelSelect.value));
		titleModelSelect?.addEventListener("change", () => this.setCurrentTitleModel(titleModelSelect.value));
		promptSelect?.addEventListener("change", () => this.loadPromptIntoForm(promptSelect.value));
		this.$("copilot-new-provider")?.addEventListener("click", () => this.clearProviderFormForNew());
		this.$("copilot-save-provider")?.addEventListener("click", () => this.saveCurrentProvider());
		this.$("copilot-delete-provider")?.addEventListener("click", () => this.deleteCurrentProvider());
		this.$("copilot-fetch-models")?.addEventListener("click", () => this.openFetchModelsDialog());
		this.$("copilot-new-model")?.addEventListener("click", () => this.clearModelFormForNew(this.currentProviderID));
		this.$("copilot-save-model")?.addEventListener("click", () => this.saveCurrentModel());
		this.$("copilot-set-active-model")?.addEventListener("click", () => this.setCurrentModelActive());
		this.$("copilot-delete-model")?.addEventListener("click", () => this.deleteCurrentModel());
		this.$("copilot-new-system-prompt")?.addEventListener("click", () => this.clearPromptFormForNew());
		this.$("copilot-save-system-prompt")?.addEventListener("click", () => this.saveCurrentPrompt());
		this.$("copilot-set-active-system-prompt")?.addEventListener("click", () => this.setCurrentPromptActive());
		this.$("copilot-delete-system-prompt")?.addEventListener("click", () => this.deleteCurrentPrompt());
		this.$("copilot-test-llm")?.addEventListener("click", () => this.testConnection());
		this.$("copilot-add-selected-models")?.addEventListener("click", () => this.addSelectedModels());
		this.$("copilot-close-model-picker")?.addEventListener("click", () => this.closeModelPicker());
		this.$("copilot-close-model-picker-footer")?.addEventListener("click", () => this.closeModelPicker());
		this.$("copilot-model-picker-search")?.addEventListener("input", (event) => this.filterModelPickerList(event.target?.value || ""));
	}
};

window.ZoteroCopilotPreferences = ZoteroCopilotPreferences;
