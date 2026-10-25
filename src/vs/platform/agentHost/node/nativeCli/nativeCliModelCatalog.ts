/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { homedir, tmpdir } from 'os';
import { promisify } from 'util';
import { parseDocument } from 'yaml';
import { CancellationError } from '../../../../base/common/errors.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import type { IAgentModelInfo } from '../../common/agent.js';
import type { NativeCliAgentId } from '../../common/nativeCliAgentConfig.js';
import type { ConfigSchema, ModelSelection } from '../../common/state/sessionState.js';
import { NativeCliTransport, record, type INativeCliLaunch, type NativeRecord } from './nativeCliTransport.js';

export interface INativeCliModelCatalog {
	readonly models: readonly IAgentModelInfo[];
	readonly defaultModel: ModelSelection | undefined;
}

function effortSchema(values: readonly string[], defaultValue?: string, labels: readonly string[] = values): ConfigSchema | undefined {
	return values.length ? { type: 'object', properties: { reasoningEffort: { type: 'string', title: localize('nativeCli.thinkingEffort', "Thinking Effort"), enum: [...values], enumLabels: [...labels], ...(defaultValue && values.includes(defaultValue) ? { default: defaultValue } : {}) } } } : undefined;
}

/** Reads only presentation and routing fields; YAML tags, including !!js, are never evaluated. */
export function dshModelCatalog(text: string, builtinModels: readonly NativeRecord[] = []): INativeCliModelCatalog {
	const document = parseDocument(text, { logLevel: 'silent' });
	if (document.errors.length) { throw new Error(localize('nativeCli.invalidDshCatalog', "Could not read the DSH model configuration.")); }
	const entries: NativeRecord[] = [];
	const visited = new Set<object>();
	const visit = (value: unknown): void => {
		if (typeof value !== 'object' || value === null || visited.has(value)) { return; }
		visited.add(value);
		if (Array.isArray(value)) { for (const item of value) { visit(item); } return; }
		const row = record(value);
		if (row.disabled === true || row.enabled === false) { return; }
		if (typeof row.name === 'string' && row.name.startsWith('@deepseek-ai/')) { entries.push(row); }
		for (const child of Object.values(row)) { visit(child); }
	};
	visit(document.toJS());
	const selected = record(entries.find(entry => entry.name === '@deepseek-ai/dsh-agent-default-model')?.config);
	const selectedId = typeof selected.provider === 'string' && typeof selected.model === 'string' ? `${selected.provider}/${selected.model}` : undefined;
	const models = new Map<string, IAgentModelInfo>();
	const add = (provider: string, raw: NativeRecord): void => {
		if (typeof raw.id !== 'string' || !raw.id || raw.disabled === true || raw.enabled === false) { return; }
		const id = `${provider}/${raw.id}`;
		const efforts = Object.keys(record(raw.reasoningEfforts));
		const selectedEffort = id === selectedId && typeof selected.reasoningEffort === 'string' ? selected.reasoningEffort : undefined;
		models.set(id, { provider: 'dsh', id, name: typeof raw.name === 'string' ? raw.name : raw.id, supportsVision: false, maxContextWindow: typeof raw.contextWindow === 'number' ? raw.contextWindow : undefined, maxOutputTokens: typeof raw.maxTokens === 'number' ? raw.maxTokens : undefined, configSchema: effortSchema(efforts, selectedEffort) });
	};
	for (const entry of entries) {
		const config = record(entry.config);
		if (entry.name === '@deepseek-ai/dsh-llm-pi-ai') {
			for (const [id, value] of Object.entries(record(config.providers))) {
				const provider = record(value);
				for (const model of Array.isArray(provider.models) ? provider.models : []) { add(id, record(model)); }
			}
		}
		if (entry.name === '@deepseek-ai/dsh-llm-deepseek-api-key' || entry.name === '@deepseek-ai/dsh-llm-deepseek') {
			const configured = Array.isArray(config.models) ? config.models.map(record) : [];
			if (configured.length || selected.provider === 'deepseek-official') {
				for (const model of configured.length ? configured : builtinModels) { add('deepseek-official', model); }
			}
		}
	}
	if (selected.provider === 'deepseek-account') {
		for (const model of builtinModels) { add('deepseek-account', model); }
	}
	if (selectedId && !models.has(selectedId)) { add(String(selected.provider), { id: selected.model }); }
	const ordered = [...models.values()].sort((a, b) => Number(b.id === selectedId) - Number(a.id === selectedId));
	return { models: ordered, defaultModel: ordered.length ? { id: ordered[0].id, ...(typeof selected.reasoningEffort === 'string' && ordered[0].id === selectedId ? { config: { reasoningEffort: selected.reasoningEffort } } : {}) } : undefined };
}

/** Uses the native resolved catalog, including provider defaults and model-specific reasoning rules. */
export function zcodeModelCatalog(snapshot: NativeRecord): INativeCliModelCatalog {
	const available = record(record(snapshot.settings).model).available;
	const models: IAgentModelInfo[] = [];
	for (const item of Array.isArray(available) ? available : []) {
		const model = record(item);
		const ref = record(model.ref);
		// Subscription models require the desktop header bridge; they are not usable through this adapter.
		if (typeof ref.providerId !== 'string' || typeof ref.modelId !== 'string' || ref.providerId.startsWith('account:') || model.disabledReason) { continue; }
		const reasoning = record(model.reasoning);
		const levels = (Array.isArray(reasoning.levels) ? reasoning.levels : []).map(record).filter(level => typeof level.value === 'string');
		models.push({ provider: 'zcode', id: `${ref.providerId}/${ref.modelId}`, name: typeof model.label === 'string' ? model.label : ref.modelId, supportsVision: false, maxContextWindow: typeof model.contextWindow === 'number' ? model.contextWindow : undefined, configSchema: effortSchema(levels.map(level => String(level.value)), typeof reasoning.defaultLevel === 'string' ? reasoning.defaultLevel : undefined, levels.map(level => String(level.label ?? level.value))) });
	}
	return { models, defaultModel: models.length ? { id: models[0].id } : undefined };
}

async function readDshCatalog(launch: INativeCliLaunch, signal: AbortSignal): Promise<INativeCliModelCatalog> {
	const run = (flag: string) => promisify(execFile)(launch.executable, [...launch.args, flag], { cwd: launch.cwd, env: launch.env, signal, windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' });
	const { stdout } = await run('--dump-config');
	let catalog = dshModelCatalog(stdout);
	// Built-in names come from the installed SDK schema, rather than a second hardcoded model list.
	if (!catalog.models.length || catalog.models.every(model => model.id.startsWith('deepseek-'))) {
		const schema = record(JSON.parse((await run('--dump-config-schema')).stdout));
		const entries = record(schema['x-cordis']).entries;
		const builtin: NativeRecord[] = [];
		for (const raw of Array.isArray(entries) ? entries : []) {
			const entry = record(raw);
			if (entry.name !== '@deepseek-ai/dsh-llm-deepseek-api-key' || typeof entry.configRef !== 'string') { continue; }
			let definition: unknown = schema;
			for (const part of entry.configRef.replace(/^#\//, '').split('/')) { definition = record(definition)[part]; }
			const alternatives = record(definition).anyOf;
			for (const option of Array.isArray(alternatives) ? alternatives : []) {
				const defaults = record(record(record(option).properties).models).default;
				if (Array.isArray(defaults)) { builtin.push(...defaults.map(record)); }
			}
		}
		catalog = dshModelCatalog(stdout, builtin);
	}
	return catalog;
}

/** Catalog inspection uses a disposable native home, never a conversation in the user's history. */
async function readZcodeCatalog(launch: INativeCliLaunch, signal: AbortSignal): Promise<INativeCliModelCatalog> {
	if (signal.aborted) { throw new CancellationError(); }
	const temporary = await fs.mkdtemp(join(tmpdir(), 'vscode-zcode-catalog-'));
	const store = new DisposableStore();
	let connection: NativeCliTransport | undefined;
	try {
		const env: NodeJS.ProcessEnv = { ...launch.env, ZCODE_DATA_BASE_DIR: temporary };
		const copy = async (source: string, filename: string): Promise<string | undefined> => {
			try { await fs.access(source); } catch { return undefined; }
			const target = join(temporary, filename);
			await fs.copyFile(source, target);
			await fs.chmod(target, 0o600);
			return target;
		};
		const personal = launch.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE ?? join(launch.env.ZCODE_DATA_BASE_DIR || homedir(), '.zcode/v2/provider_config.json');
		env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = await copy(personal, 'provider_config.json');
		if (launch.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE) { env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = await copy(launch.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, 'builtin.json'); }
		const cwd = join(temporary, 'workspace');
		await fs.mkdir(cwd);
		if (signal.aborted) { throw new CancellationError(); }
		connection = store.add(new NativeCliTransport({ ...launch, cwd, env }));
		const transport = connection;
		const abort = () => { void transport.shutdown(); };
		signal.addEventListener('abort', abort, { once: true });
		store.add(toDisposable(() => signal.removeEventListener('abort', abort)));
		transport.onRequest = async method => {
			if (method === 'session/requestRuntimePreferences') { return zcodeRuntimePreferences(); }
			if (method === 'interaction/requestProviderRuntimeHeaders') { return { headersApplied: false }; }
			throw new Error('Unsupported native catalog request');
		};
		await transport.request('runtime/capabilities');
		const snapshot = await transport.request('session/create', { sessionId: `sess_${generateUuid()}`, workspace: { workspacePath: cwd, workspaceKey: cwd }, mode: 'build' });
		return zcodeModelCatalog(record(snapshot));
	} finally {
		await connection?.shutdown();
		store.dispose();
		await fs.rm(temporary, { recursive: true, force: true });
	}
}

export function zcodeRuntimePreferences(): NativeRecord {
	return { nativeSearchEnhancementsEnabled: true, toolSearchMode: 'off', memoryEnabled: false, askUserQuestionAutoResolutionEnabled: false, modelContextBudgetStrategy: 'preflight-v1' };
}

export async function discoverNativeCliModels(id: NativeCliAgentId, launch: INativeCliLaunch, signal: AbortSignal): Promise<INativeCliModelCatalog> {
	return id === 'dsh' ? readDshCatalog(launch, signal) : readZcodeCatalog(launch, signal);
}
