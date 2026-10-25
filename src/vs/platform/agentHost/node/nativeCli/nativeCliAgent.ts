/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'fs';
import { homedir, tmpdir } from 'os';
import { isAbsolute, join } from '../../../../base/common/path.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../log/common/log.js';
import { INativeEnvironmentService } from '../../../environment/common/environment.js';
import { AgentSession, type AgentSignal, type IActiveClient, type IAgent, type IAgentChatContext, type IAgentChatDataChange, type IAgentChats, type IAgentCreateChatOptions, type IAgentCreateChatResult, type IAgentMaterializeChatEvent, type IAgentModelInfo, resolveAgentChatContext } from '../../common/agent.js';
import { type INativeCliAgentConfig, type NativeCliAgentId, nativeCliAgentEnv, nativeCliAgentIds } from '../../common/nativeCliAgentConfig.js';
import { ISessionDataService } from '../../common/sessionDataService.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { ChatInputAnswerState, ChatInputAnswerValueKind, ChatInputQuestionKind, ChatInputResponseKind, TurnState, type ChatInputAnswer, type ChatInputQuestion, type Customization, type ModelSelection, type Turn } from '../../common/state/sessionState.js';
import { NativeCliTransport, record, type INativeCliLaunch, type NativeRecord } from './nativeCliTransport.js';
import { NativeCliTurn } from './nativeCliTurn.js';
import { ensureWorkspacelessScratchDir } from '../workspacelessScratchDir.js';
import { discoverNativeCliModels, zcodeModelCatalog, zcodeRuntimePreferences } from './nativeCliModelCatalog.js';

interface IBacking {
	version: 1;
	provider: NativeCliAgentId;
	nativeId: string;
	cwd: string;
	model: ModelSelection;
	persisted: boolean;
	createdAt: number;
	modifiedAt: number;
	workspaceless?: boolean;
}

interface IChat {
	readonly uri: URI;
	readonly resource: URI;
	readonly backing: IBacking;
	readonly history: Turn[];
	readonly clients: Map<string, IActiveClient>;
	readonly pending: Set<DeferredPromise<unknown>>;
	process: NativeCliTransport | undefined;
	processStore: DisposableStore | undefined;
	starting: Promise<NativeCliTransport> | undefined;
	stopping: Promise<void> | undefined;
	active: NativeCliTurn | undefined;
	completion: DeferredPromise<void> | undefined;
	write: Promise<void>;
	lastSaved: number;
	disposed: boolean;
	generation: number;
}

/** Validates the starter's JSON, rather than trusting environment-provided process arguments. */
export function readNativeCliAgentConfigs(env: Readonly<NodeJS.ProcessEnv>): ReadonlyMap<NativeCliAgentId, INativeCliAgentConfig> {
	const result = new Map<NativeCliAgentId, INativeCliAgentConfig>();
	const configs = record(JSON.parse(env[nativeCliAgentEnv] ?? '{}'));
	for (const id of nativeCliAgentIds) {
		const config = record(configs[id]);
		if (config.enabled !== true) { continue; }
		if ((config.executable !== undefined && typeof config.executable !== 'string') || (config.home !== undefined && typeof config.home !== 'string') || (config.args !== undefined && (!Array.isArray(config.args) || !config.args.every(arg => typeof arg === 'string')))) {
			throw new Error(localize('nativeCli.invalidLaunch', "Invalid {0} native agent launch configuration.", id));
		}
		const models = Array.isArray(config.models) ? config.models.map(value => {
			const model = record(value);
			if (typeof model.id !== 'string' || !model.id || typeof model.name !== 'string') { throw new Error(localize('nativeCli.invalidModel', "Invalid {0} model configuration.", id)); }
			return { id: model.id, name: model.name };
		}) : [];
		result.set(id, { enabled: true, executable: String(config.executable ?? ''), home: String(config.home ?? ''), args: (config.args ?? []) as string[], models });
	}
	return result;
}

/** Builds a native launch without modifying either application's configuration. */
export async function nativeCliLaunch(id: NativeCliAgentId, config: INativeCliAgentConfig, cwd: string, inherited: NodeJS.ProcessEnv = process.env): Promise<INativeCliLaunch> {
	const env = { ...inherited };
	const exists = async (path: string): Promise<boolean> => { try { await fs.access(path); return true; } catch { return false; } };
	if (config.executable === process.execPath) { env.ELECTRON_RUN_AS_NODE = '1'; }
	if (id === 'dsh') {
		if (config.home) { env.DSH_HOME = config.home; }
		const bundled = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
		return { executable: config.executable || (process.platform === 'darwin' && await exists(bundled) ? bundled : 'dsh'), args: config.args.length ? config.args : ['--profile', 'sdk'], env, cwd, jsonrpc: true };
	}
	if (config.home) { env.ZCODE_DATA_BASE_DIR = config.home; }
	const resources = '/Applications/ZCode.app/Contents/Resources';
	if (!config.executable && process.platform === 'darwin' && await exists(join(resources, 'glm/zcode.cjs'))) {
		env.ELECTRON_RUN_AS_NODE = '1';
		// The desktop's flattened CLI location needs explicit provider paths.
		const base = env.ZCODE_DATA_BASE_DIR || homedir();
		const builtin = join(resources, 'config/provider/zcode-builtin.json');
		env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE ??= builtin;
		env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE ??= join(base, '.zcode/v2/provider_config.json');
		return { executable: '/Applications/ZCode.app/Contents/MacOS/ZCode', args: [join(resources, 'glm/zcode.cjs'), ...(config.args.length ? config.args : ['app-server', '--stdio'])], env, cwd, jsonrpc: false };
	}
	return { executable: config.executable || 'zcode', args: config.args.length ? config.args : ['app-server', '--stdio'], env, cwd, jsonrpc: false };
}

/** A provider adapter; native conversations, tools and model execution stay inside the CLI. */
export class NativeCliAgent extends Disposable implements IAgent {
	readonly agentHostCapabilities = { workspaceConversion: false };
	readonly onDidSpawnChat = Event.None;
	readonly onDidDiscoverChats = Event.None;
	private readonly progress = this._register(new Emitter<AgentSignal>());
	readonly onDidChatProgress = this.progress.event;
	private readonly materialized = this._register(new Emitter<IAgentMaterializeChatEvent>());
	readonly onDidMaterializeChat = this.materialized.event;
	private readonly changed = this._register(new Emitter<IAgentChatDataChange>());
	readonly onDidChangeChatData = this.changed.event;
	private readonly catalog = observableValue<readonly IAgentModelInfo[]>(this, []);
	readonly models = this.catalog;
	private readonly entries = new Map<string, IChat>();
	private readonly permissions = new Map<string, { chat: IChat; deferred: DeferredPromise<unknown>; method: string }>();
	private shutdownTask: Promise<void> | undefined;
	private closing = false;
	private readonly catalogAbort = new AbortController();
	private readonly catalogReady: Promise<void>;
	private defaultModel: ModelSelection | undefined;

	constructor(
		readonly id: NativeCliAgentId,
		private readonly config: INativeCliAgentConfig,
		@ISessionDataService private readonly dataService: ISessionDataService,
		@ILogService private readonly logService: ILogService,
		@INativeEnvironmentService private readonly environmentService: INativeEnvironmentService,
	) {
		super();
		this._register(toDisposable(() => this.catalogAbort.abort()));
		if (config.models.length) {
			this.catalog.set(config.models.map(model => ({ ...model, provider: id, supportsVision: false })), undefined);
			this.defaultModel = { id: config.models[0].id };
			this.catalogReady = Promise.resolve();
		} else {
			this.catalogReady = this.loadModelCatalog();
		}
	}

	private async loadModelCatalog(): Promise<void> {
		try {
			const launch = await nativeCliLaunch(this.id, this.config, this.environmentService.userHome.fsPath);
			const catalog = await discoverNativeCliModels(this.id, launch, this.catalogAbort.signal);
			if (!this.closing) {
				this.defaultModel = catalog.defaultModel;
				this.catalog.set(catalog.models, undefined);
			}
		} catch {
			// CLI configuration dumps can contain credentials. Never log their output or parser errors.
			if (!this.closing) { this.logService.warn('Native model catalog unavailable', this.id); }
		}
	}

	getDescriptor() {
		return { provider: this.id, displayName: this.id === 'dsh' ? localize('dsh.displayName', "DeepSeek Harness") : localize('zcode.displayName', "ZCode"), description: localize('nativeCli.description', "Agent running in a local native CLI process"), capabilities: { multipleChats: {} } };
	}

	readonly chats: IAgentChats = {
		createChat: (chat, context, options) => this.create(chat, resolveAgentChatContext(context, chat), options),
		disposeChat: async chat => {
			const entry = this.entries.get(chat.toString());
			if (entry) { entry.disposed = true; await this.stop(entry); await entry.write; this.entries.delete(chat.toString()); }
		},
		releaseChat: async chat => {
			const entry = this.entries.get(chat.toString());
			if (entry && !entry.active) { await this.stop(entry); }
		},
		sendMessage: (chat, prompt, directories, attachments, turnId, _sender, clientTypeOrContext, context) => {
			const operationContext = context ?? (typeof clientTypeOrContext === 'string' ? undefined : clientTypeOrContext);
			if (!operationContext) { return Promise.reject(new Error(localize('nativeCli.missingContext', "Native CLI send requires a chat context."))); }
			if (attachments?.length) { return Promise.reject(new Error(localize('nativeCli.attachments', "Native CLI agents currently accept text prompts. Reference workspace files by path."))); }
			const roots = Array.isArray(directories) ? directories : directories ? [directories] : undefined;
			return this.send(chat, prompt, turnId ?? generateUuid(), roots, resolveAgentChatContext(operationContext, chat));
		},
		abort: async chat => { const entry = this.entries.get(chat.toString()); if (entry) { await this.stop(entry); } },
		getModel: chat => this.entries.get(chat.toString())?.backing.model,
		changeModel: async (chat, model) => {
			const entry = this.require(chat);
			if (JSON.stringify(entry.backing.model) === JSON.stringify(model)) { return; }
			if (entry.active) { throw new Error(localize('nativeCli.changeDuringTurn', "Stop the native agent before changing its model.")); }
			await this.stop(entry);
			entry.backing.model = model;
			this.publish(entry);
		},
		changeAgent: async (_chat, agent) => { if (agent) { throw new Error(localize('nativeCli.customAgent', "This native agent does not support VS Code custom agent selection.")); } },
		getMessages: async chat => structuredClone(this.require(chat).history),
	};

	private require(chat: URI): IChat {
		const entry = this.entries.get(chat.toString());
		if (!entry || entry.disposed || this.closing) { throw new Error(localize('nativeCli.unavailable', "Native agent chat is unavailable.")); }
		return entry;
	}

	private async create(chat: URI, context: IAgentChatContext, options?: IAgentCreateChatOptions): Promise<IAgentCreateChatResult> {
		await this.catalogReady;
		if (this.closing) { throw new CancellationError(); }
		if (options?.fork || options?.importConversation) { throw new Error(localize('nativeCli.branching', "Native CLI conversation branching and import are not supported.")); }
		if (this.entries.has(chat.toString())) { throw new Error(localize('nativeCli.chatExists', "Native agent chat already exists.")); }
		const directories = options?.workingDirectories ?? context.launchWorkingDirectories;
		if (directories && (directories.length > 1 || directories.some(directory => directory.scheme !== 'file'))) { throw new Error(localize('nativeCli.singleRoot', "Native CLI agents support one local workspace folder per chat.")); }
		const workspaceless = context.workspaceless || !directories?.length;
		const cwd = directories?.[0]?.fsPath ?? (await ensureWorkspacelessScratchDir(this.environmentService.userHome, AgentSession.id(context.owner.get()))).fsPath;
		if (!isAbsolute(cwd)) { throw new Error(localize('nativeCli.workspaceRequired', "Native CLI agents require a local workspace folder.")); }
		if (workspaceless) { await fs.mkdir(cwd, { recursive: true }); }
		const model = options?.model ?? this.defaultModel;
		if (!model) { throw new Error(localize('nativeCli.modelsUnavailable', "Could not read the {0} model catalog. Check its native provider configuration and restart the local agent host.", this.id)); }
		const entry = this.newEntry(chat, context.resource, { version: 1, provider: this.id, nativeId: this.id === 'zcode' ? `sess_${generateUuid()}` : generateUuid(), cwd, model, workspaceless, persisted: false, createdAt: Date.now(), modifiedAt: Date.now() });
		return { providerData: JSON.stringify(entry.backing), provisional: true };
	}

	private newEntry(uri: URI, resource: URI, backing: IBacking, history: Turn[] = []): IChat {
		if (this.closing) { throw new Error(localize('nativeCli.shuttingDown', "Native agent is shutting down.")); }
		const entry: IChat = { uri, resource, backing, history, clients: new Map(), pending: new Set(), process: undefined, processStore: undefined, starting: undefined, stopping: undefined, active: undefined, completion: undefined, write: Promise.resolve(), lastSaved: 0, disposed: false, generation: 0 };
		this.entries.set(uri.toString(), entry);
		return entry;
	}

	async materializeChat(chat: URI, context: URI | IAgentChatContext, providerData: string | undefined): Promise<IAgentCreateChatResult> {
		if (!providerData) { throw new Error(localize('nativeCli.missingBacking', "Native agent conversation has no saved backing.")); }
		const raw = record(JSON.parse(providerData));
		const model = record(raw.model);
		if (raw.version !== 1 || raw.provider !== this.id || typeof raw.nativeId !== 'string' || typeof raw.cwd !== 'string' || !isAbsolute(raw.cwd) || typeof model.id !== 'string' || typeof raw.createdAt !== 'number' || typeof raw.modifiedAt !== 'number' || typeof raw.persisted !== 'boolean') { throw new Error(localize('nativeCli.invalidBacking', "Invalid saved native agent conversation.")); }
		const backing = raw as unknown as IBacking;
		if (!this.entries.has(chat.toString())) {
			const resource = resolveAgentChatContext(context, chat).resource;
			const ref = this.dataService.openDatabase(resource);
			let history: Turn[];
			try {
				const text = await ref.object.getMetadata(this.historyKey(chat));
				const saved: unknown = text ? JSON.parse(text) : [];
				if (!Array.isArray(saved) || !saved.every(item => typeof record(item).id === 'string' && Array.isArray(record(item).responseParts) && typeof record(record(item).message).text === 'string')) { throw new Error(localize('nativeCli.invalidHistory', "Invalid saved native agent transcript.")); }
				history = (saved as Turn[]).map(turn => ({ ...turn, usage: turn.usage }));
			} finally { ref.dispose(); }
			this.newEntry(chat, resource, backing, history);
		}
		return { providerData };
	}

	private historyKey(chat: URI): string { return `${this.id}.history.${chat.toString()}`; }

	private save(entry: IChat, force = false): Promise<void> {
		if (!force && Date.now() - entry.lastSaved < 500) { return entry.write; }
		entry.lastSaved = Date.now();
		const text = JSON.stringify(entry.history);
		entry.write = entry.write.catch(error => this.logService.error('Native agent transcript persistence failed', error)).then(async () => {
			const ref = this.dataService.openDatabase(entry.resource);
			try { await ref.object.setMetadata(this.historyKey(entry.uri), text); } finally { ref.dispose(); }
		});
		return entry.write;
	}

	private publish(entry: IChat): void {
		this.changed.fire({ chat: entry.uri, providerData: JSON.stringify(entry.backing) });
	}

	private ensureProcess(entry: IChat): Promise<NativeCliTransport> {
		const generation = entry.generation;
		return entry.starting ??= (async () => {
			await entry.stopping;
			if (entry.generation !== generation || entry.disposed || this.closing) { throw new CancellationError(); }
			if (entry.process) { return entry.process; }
			if (entry.backing.workspaceless) { await fs.mkdir(entry.backing.cwd, { recursive: true }); }
			const launch = await nativeCliLaunch(this.id, this.config, entry.backing.cwd);
			let temporary: string | undefined;
			if (this.id === 'zcode' && !this.config.executable && launch.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE?.startsWith('/Applications/')) {
				temporary = await fs.mkdtemp(join(tmpdir(), 'vscode-zcode-provider-'));
				try {
					const copy = join(temporary, 'zcode-builtin.json');
					await fs.copyFile(launch.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, copy);
					launch.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = copy;
				} catch (error) { await fs.rm(temporary, { recursive: true, force: true }); throw error; }
			}
			if (entry.generation !== generation || entry.disposed || this.closing) {
				if (temporary) { await fs.rm(temporary, { recursive: true, force: true }); }
				throw new CancellationError();
			}
			const connection = new NativeCliTransport(launch);
			entry.process = connection;
			const store = entry.processStore = new DisposableStore();
			store.add(connection);
			if (temporary) {
				const directory = temporary;
				store.add(toDisposable(() => { void fs.rm(directory, { recursive: true, force: true }).catch(error => this.logService.warn('Native agent temporary cleanup failed', error)); }));
			}
			store.add(connection.onExit(error => {
				if (entry.process === connection && !entry.stopping) {
					entry.process = undefined;
					this.cancelRequests(entry);
					void entry.completion?.error(error);
					entry.stopping = connection.shutdown().finally(() => {
						store.dispose();
						if (entry.processStore === store) { entry.processStore = undefined; }
						entry.stopping = undefined;
					});
				}
			}));
			store.add(connection.onNotification(({ method, params }) => this.notification(entry, connection, method, params)));
			connection.onRequest = (method, params) => this.requestFromNative(entry, method, params);
			try {
				if (this.id === 'dsh') {
					const [provider, ...model] = entry.backing.model.id.split('/');
					if (!provider || !model.length) { throw new Error(localize('nativeCli.dshModelId', "DSH model IDs must use provider/model format.")); }
					await connection.request('initialize', { cwd: entry.backing.cwd, provider, model: model.join('/'), ...(typeof entry.backing.model.config?.reasoningEffort === 'string' ? { reasoningEffort: entry.backing.model.config.reasoningEffort } : {}), approvalRequests: true, capabilities: { userQuestions: true } });
					await connection.request(entry.backing.persisted ? 'session/resume' : 'session/working-directory/get', { sessionId: entry.backing.nativeId });
				} else {
					await connection.request('runtime/capabilities', {});
					// Discover the native model defaults before selecting a route: ZCode
					// requires an explicit thinking level for some configured models.
					const snapshot = record(await connection.request(entry.backing.persisted ? 'session/resume' : 'session/create', { sessionId: entry.backing.nativeId, workspace: { workspacePath: entry.backing.cwd, workspaceKey: entry.backing.cwd }, ...(entry.backing.persisted ? {} : { mode: 'build' }) }));
					this.updateZcodeModels(snapshot);
					await connection.request('session/subscribe', { sessionId: entry.backing.nativeId, deliveryKind: 'web-remote-replayable', includeSnapshot: false });
				}
				if (entry.generation !== generation || entry.process !== connection || entry.disposed || this.closing) { throw new CancellationError(); }
				entry.backing.persisted = true;
				this.publish(entry);
				this.materialized.fire({ chat: entry.uri, result: { providerData: JSON.stringify(entry.backing) }, workingDirectories: [URI.file(entry.backing.cwd)], project: entry.backing.workspaceless ? undefined : { uri: URI.file(entry.backing.cwd), displayName: entry.backing.cwd.split(/[\\/]/).pop() ?? entry.backing.cwd } });
				return connection;
			} catch (error) {
				if (entry.process === connection) { entry.process = undefined; }
				await connection.shutdown();
				store.dispose();
				throw error;
			}
		})().finally(() => { entry.starting = undefined; });
	}

	private zcodeModel(model: ModelSelection): NativeRecord | undefined {
		if (model.id === 'default') { return undefined; }
		const index = model.id.indexOf('/');
		if (index < 1) { throw new Error(localize('nativeCli.zcodeModelId', "ZCode model IDs must use provider/model format.")); }
		const effort = model.config?.reasoningEffort ?? this.catalog.get().find(candidate => candidate.id === model.id)?.configSchema?.properties.reasoningEffort?.default;
		return { providerId: model.id.slice(0, index), modelId: model.id.slice(index + 1), ...(typeof effort === 'string' ? { options: { reasoningLevel: effort } } : {}) };
	}

	private updateZcodeModels(snapshot: NativeRecord): void {
		const discovered = zcodeModelCatalog(snapshot).models;
		if (discovered.length) {
			const configured = new Map(this.config.models.map(model => [model.id, model.name]));
			this.catalog.set(discovered.filter(model => !configured.size || configured.has(model.id)).map(model => ({ ...model, name: configured.get(model.id) ?? model.name })), undefined);
		}
	}

	private async send(chat: URI, prompt: string, turnId: string, roots: readonly URI[] | undefined, _context: IAgentChatContext): Promise<void> {
		const entry = this.require(chat);
		const generation = entry.generation;
		if (entry.active) { throw new Error(localize('nativeCli.alreadyRunning', "A native agent turn is already running.")); }
		if (roots && (roots.length > 1 || roots.some(directory => directory.scheme !== 'file'))) { throw new Error(localize('nativeCli.singleRoot', "Native CLI agents support one local workspace folder per chat.")); }
		if (roots?.[0] && roots[0].fsPath !== entry.backing.cwd) {
			if (entry.backing.persisted) { throw new Error(localize('nativeCli.workspaceMismatch', "This native conversation is bound to a different workspace.")); }
			entry.backing.cwd = roots[0].fsPath;
		}
		const turn = entry.active = new NativeCliTurn(chat, turnId, prompt, entry.backing.model, signal => this.progress.fire(signal));
		const completion = entry.completion = new DeferredPromise<void>();
		// The exit/abort path can reject before startup or admission finishes.
		void completion.p.catch(() => { });
		entry.history.push(turn.turn);
		try {
			const connection = await this.ensureProcess(entry);
			if (entry.generation !== generation || entry.active !== turn || entry.stopping) { throw new CancellationError(); }
			if (this.id === 'dsh') {
				await connection.request('session/prompt', { sessionId: entry.backing.nativeId, contentBlocks: [{ type: 'text', text: prompt }] });
				await connection.request('session/wait', { sessionId: entry.backing.nativeId }, 0);
				void completion.complete();
			} else {
				await connection.request('session/send', { sessionId: entry.backing.nativeId, inputId: turnId, content: prompt, ...(this.zcodeModel(entry.backing.model) ? { modelSelection: this.zcodeModel(entry.backing.model) } : {}) });
			}
			await completion.p;
			turn.finish(TurnState.Complete);
		} catch (error) {
			const cancelled = error instanceof CancellationError || entry.generation !== generation || entry.disposed || this.closing;
			turn.finish(cancelled ? TurnState.Cancelled : TurnState.Error, cancelled ? undefined : error instanceof Error ? error.message : String(error));
			if (!cancelled) { throw error; }
		} finally {
			entry.backing.modifiedAt = Date.now();
			if (entry.active === turn) { entry.active = undefined; entry.completion = undefined; }
			await this.save(entry, true);
			this.publish(entry);
		}
	}

	private notification(entry: IChat, connection: NativeCliTransport, method: string, params: NativeRecord): void {
		if (entry.process !== connection || entry.stopping || !entry.active) { return; }
		if (this.id === 'dsh' && method === 'session.event' && params.sessionId === entry.backing.nativeId) {
			const event = record(params.event);
			entry.active.dsh(event);
			if (event.type === 'turn/end') {
				const reason = record(record(event.data).reason);
				if (reason.kind === 'error' || reason.kind === 'failed') { void entry.completion?.error(new Error(String(reason.message ?? 'DeepSeek Harness turn failed.'))); }
			}
		} else if (this.id === 'zcode' && method === 'session/event' && params.sessionId === entry.backing.nativeId) {
			const result = entry.active.zcode(params);
			if (result.finished) {
				if (result.cancelled) { void entry.completion?.error(new CancellationError()); }
				else if (result.error) { void entry.completion?.error(new Error(result.error)); }
				else { void entry.completion?.complete(); }
			}
		}
		void this.save(entry).catch(error => this.logService.error('Native agent history save failed', error));
	}

	private async requestFromNative(entry: IChat, method: string, params: NativeRecord): Promise<unknown> {
		const turn = entry.active;
		if (entry.stopping || params.sessionId !== entry.backing.nativeId) { throw new CancellationError(); }
		if (this.id === 'zcode' && method === 'session/requestRuntimePreferences') {
			return zcodeRuntimePreferences();
		}
		if (this.id === 'zcode' && method === 'interaction/requestProviderRuntimeHeaders') {
			return { headersApplied: false, errorMessage: localize('nativeCli.accountAuthentication', "This ZCode account model requires the desktop authentication bridge. Select an API-key provider configured in ZCode.") };
		}
		if (!turn) { throw new CancellationError(); }
		const deferred = new DeferredPromise<unknown>();
		const permission = method === 'approval/request' || method === 'interaction/requestPermission';
		const question = method === 'user-question/ask' || method === 'interaction/requestUserInput';
		if (!permission && !question) { throw new Error(`Unsupported native request: ${method}`); }
		const id = permission && typeof params.toolCallId === 'string' ? params.toolCallId : typeof params.requestId === 'string' ? params.requestId : typeof params.callId === 'string' ? params.callId : generateUuid();
		const key = permission ? turn.toolId(id) : `${this.id}:${entry.backing.nativeId}:${id}`;
		entry.pending.add(deferred);
		this.permissions.set(key, { chat: entry, deferred, method });
		if (permission) {
			turn.tool(id, String(params.toolName ?? 'tool'), params.input, true);
		} else {
			const questions: ChatInputQuestion[] = (Array.isArray(params.questions) ? params.questions : []).map((raw, index) => {
				const q = record(raw);
				const options = Array.isArray(q.options) ? q.options.map((rawOption, optionIndex) => {
					const option = record(rawOption);
					return { id: String(option.id ?? option.value ?? (typeof rawOption === 'string' ? rawOption : optionIndex)), label: String(option.label ?? (typeof rawOption === 'string' ? rawOption : option.id ?? optionIndex)) };
				}) : [];
				const base = { id: String(q.id ?? (this.id === 'zcode' ? q.question ?? index : index)), message: String(q.question ?? q.message ?? q.title ?? ''), required: true };
				return options.length ? { ...base, kind: q.multiSelect === true ? ChatInputQuestionKind.MultiSelect : ChatInputQuestionKind.SingleSelect, options, allowFreeformInput: true } : { ...base, kind: ChatInputQuestionKind.Text };
			});
			turn.action({ type: ActionType.ChatInputRequested, request: { id: key, questions } });
		}
		try { return await deferred.p; } finally { entry.pending.delete(deferred); this.permissions.delete(key); }
	}

	respondToPermissionRequest(id: string, approved: boolean): void {
		const request = this.permissions.get(id);
		if (!request) { return; }
		void request.deferred.complete(request.method === 'approval/request' ? { outcome: approved ? 'allowed-once' : 'rejected' } : { decision: approved ? 'allow' : 'deny' });
	}

	respondToUserInputRequest(id: string, response: ChatInputResponseKind, answers?: Record<string, ChatInputAnswer>): void {
		const request = this.permissions.get(id);
		if (!request) { return; }
		if (response !== ChatInputResponseKind.Accept) {
			if (request.method === 'interaction/requestUserInput') { void request.deferred.complete({ action: 'cancel' }); }
			else { void request.deferred.error(new CancellationError()); }
			return;
		}
		const values = Object.entries(answers ?? {}).map(([key, answer]) => {
			if (answer.state === ChatInputAnswerState.Skipped) { return { id: key, selected: [], custom: '' }; }
			const value = answer.value;
			return { id: key, selected: value.kind === ChatInputAnswerValueKind.Selected ? [value.value] : value.kind === ChatInputAnswerValueKind.SelectedMany ? value.value : [], custom: value.kind === ChatInputAnswerValueKind.Text ? value.value : undefined };
		});
		void request.deferred.complete(request.method === 'user-question/ask' ? { answers: values } : { action: 'accept', content: { answers: Object.fromEntries(values.map(value => [value.id, value.custom ?? value.selected.join(', ')])) } });
	}

	private stop(entry: IChat): Promise<void> {
		if (entry.stopping) { return entry.stopping; }
		entry.generation++;
		const connection = entry.process;
		entry.process = undefined;
		this.cancelRequests(entry);
		void entry.completion?.error(new CancellationError());
		entry.stopping = (async () => {
			await connection?.shutdown();
			entry.processStore?.dispose();
			entry.processStore = undefined;
		})().finally(() => { entry.stopping = undefined; });
		return entry.stopping;
	}

	private cancelRequests(entry: IChat): void {
		for (const [id, request] of this.permissions) {
			if (request.chat === entry && (request.method === 'user-question/ask' || request.method === 'interaction/requestUserInput')) {
				entry.active?.action({ type: ActionType.ChatInputCompleted, requestId: id, response: ChatInputResponseKind.Cancel });
			}
		}
		for (const pending of entry.pending) { void pending.error(new CancellationError()); }
	}

	async getChatMetadata(chat: URI, _context: URI | IAgentChatContext, providerData?: string) {
		const backing = this.entries.get(chat.toString())?.backing ?? (providerData ? record(JSON.parse(providerData)) : undefined);
		if (!backing || typeof backing.cwd !== 'string') { return undefined; }
		return { chat, startTime: Number(backing.createdAt), modifiedTime: Number(backing.modifiedAt), workingDirectories: [URI.file(backing.cwd)], model: record(backing.model) as unknown as ModelSelection };
	}

	async resolveChatConfig() { return { schema: { type: 'object' as const, properties: {} }, values: {} }; }
	getInheritedChatConfig() { return undefined; }
	async chatConfigCompletions() { return { items: [] }; }
	async getChatCustomizations(): Promise<readonly Customization[]> { return []; }
	async listChatsToMigrate() { return []; }
	getProtectedResources() { return []; }
	async authenticate() { return false; }
	async setWorkingDirectory(): Promise<void> { throw new Error(localize('nativeCli.workspaceChange', "Native conversations retain their original workspace.")); }
	onClientToolCallComplete(): void { }
	getOrCreateActiveClient(chat: URI, _context: URI | IAgentChatContext, client: { clientId: string; displayName?: string }): IActiveClient {
		const entry = this.require(chat);
		let active = entry.clients.get(client.clientId);
		if (!active) { active = { ...client, displayName: client.displayName, tools: [], customizations: [] }; entry.clients.set(client.clientId, active); }
		return active;
	}
	removeActiveClient(chat: URI, _context: URI | IAgentChatContext, clientId: string): void { this.entries.get(chat.toString())?.clients.delete(clientId); }
	shutdown(): Promise<void> {
		this.closing = true;
		this.catalogAbort.abort();
		return this.shutdownTask ??= Promise.all([this.catalogReady, ...[...this.entries.values()].map(async entry => { await this.stop(entry); await entry.write; })]).then(() => { });
	}
	override dispose(): void { void this.shutdown(); super.dispose(); }
}
