/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { constants, promises as fs } from 'fs';
import { homedir, tmpdir } from 'os';
import { delimiter, dirname, isAbsolute, join } from '../../../../base/common/path.js';
import { sanitizeProcessEnvironment } from '../../../../base/common/processes.js';
import { DeferredPromise, Limiter } from '../../../../base/common/async.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../log/common/log.js';
import { INativeEnvironmentService } from '../../../environment/common/environment.js';
import { IInstantiationService } from '../../../instantiation/common/instantiation.js';
import { AgentSession, type AgentSignal, type IActiveClient, type IAgent, type IAgentChatContext, type IAgentChatDataChange, type IAgentChats, type IAgentCreateChatOptions, type IAgentCreateChatResult, type IAgentMaterializeChatEvent, type IAgentModelInfo, type IAgentResolveChatConfigParams, resolveAgentChatContext } from '../../common/agent.js';
import { type INativeCliAgentConfig, type NativeCliAgentId, nativeCliAgentDisplayName, nativeCliAgentEnv, nativeCliAgentIds, nativeCliPermissionModeKey } from '../../common/nativeCliAgentConfig.js';
import { ISessionDataService } from '../../common/sessionDataService.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { ChatInputAnswerState, ChatInputAnswerValueKind, ChatInputQuestionKind, ChatInputResponseKind, TurnState, type ChatInputAnswer, type ChatInputQuestion, type Customization, type ModelSelection, type Turn } from '../../common/state/sessionState.js';
import { NativeCliTransport, record, type INativeCliLaunch, type NativeRecord } from './nativeCliTransport.js';
import { NativeCliTurn } from './nativeCliTurn.js';
import { ensureWorkspacelessScratchDir } from '../workspacelessScratchDir.js';
import { discoverNativeCliModels, zcodeModelCatalog, zcodeRuntimePreferences } from './nativeCliModelCatalog.js';
import { discoverNativeCliRuntimeSnapshot, nativeCliCustomizations } from './nativeCliCustomizations.js';
import { canObserveNativeCliRuntime, observeNativeCliRuntime, type INativeCliObservedLaunch } from './nativeCliRuntime.js';
import { IAgentConfigurationService } from '../agentConfigurationService.js';
import { IAgentHostProviderService } from '../agentHostProviderService.js';
import { offersNoNativeCliPermissions, readNativeCliPermissions, resolveNativeCliPermissionConfig, type INativeCliPermissions } from './nativeCliPermissions.js';

/** A hung native CLI must not stall chat creation, so every discovery is abandoned after this long. */
const nativeDiscoveryTimeoutMs = 30_000;
/** Discovery launches the whole native runtime (plugins, MCP servers), so only a couple run at once. */
const nativeDiscoveryConcurrency = 2;
/** An inspected workspace is reused this long, so a finished turn never relaunches the CLI for idle chats. */
const nativeInventoryTtlMs = 5 * 60_000;
/** A failed discovery is not repeated sooner than this; the next demand after it tries again. */
const nativeDiscoveryRetryMs = 30_000;

/** Names a failure without echoing native output: command lines and stderr can carry credentials. */
function describeFailure(error: unknown): string {
	if (error instanceof CancellationError) { return 'cancelled'; }
	const { code, signal, killed } = record(error);
	const parts = [typeof code === 'string' || typeof code === 'number' ? `code ${code}` : undefined, typeof signal === 'string' ? `signal ${signal}` : undefined, killed === true ? 'timed out' : undefined];
	return parts.filter(Boolean).join(', ') || (error instanceof Error ? error.name : typeof error);
}

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
	permissionMode?: string;
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

/** Whether the chat finished a turn, so that its native session holds something worth keeping. */
function hasCompletedTurn(entry: IChat): boolean {
	return entry.history.some(turn => turn.state === TurnState.Complete);
}

/**
 * Validates the starter's JSON, rather than trusting environment-provided process arguments. A mistake in one
 * provider's settings throws, unless `onInvalid` is given: then it is reported there and the other provider stays usable.
 */
export function readNativeCliAgentConfigs(env: Readonly<NodeJS.ProcessEnv>, onInvalid?: (id: NativeCliAgentId, error: Error) => void): ReadonlyMap<NativeCliAgentId, INativeCliAgentConfig> {
	const result = new Map<NativeCliAgentId, INativeCliAgentConfig>();
	const configs = record(JSON.parse(env[nativeCliAgentEnv] ?? '{}'));
	for (const id of nativeCliAgentIds) {
		const config = record(configs[id]);
		if (config.enabled !== true) { continue; }
		try {
			if ((config.executable !== undefined && typeof config.executable !== 'string') || (config.home !== undefined && typeof config.home !== 'string') || (config.args !== undefined && (!Array.isArray(config.args) || !config.args.every(arg => typeof arg === 'string')))) {
				throw new Error(localize('nativeCli.invalidLaunch', "Invalid {0} native agent launch configuration.", id));
			}
			const models = Array.isArray(config.models) ? config.models.map(value => {
				const model = record(value);
				if (typeof model.id !== 'string' || !model.id || typeof model.name !== 'string') { throw new Error(localize('nativeCli.invalidModel', "Invalid {0} model configuration.", id)); }
				return { id: model.id, name: model.name };
			}) : [];
			result.set(id, { enabled: true, executable: String(config.executable ?? ''), home: String(config.home ?? ''), args: (config.args ?? []) as string[], models });
		} catch (error) {
			if (!onInvalid) { throw error; }
			onInvalid(id, error instanceof Error ? error : new Error(String(error)));
		}
	}
	return result;
}

/**
 * Registers the enabled native providers with the host. A mistake in one provider's settings is logged and leaves the
 * other provider, and the rest of the host, running.
 */
export function registerNativeCliAgents(env: Readonly<NodeJS.ProcessEnv>, providerService: IAgentHostProviderService, instantiationService: IInstantiationService, logService: ILogService): void {
	try {
		for (const [id, config] of readNativeCliAgentConfigs(env, (id, error) => logService.error(`Failed to configure the ${id} native CLI agent`, error))) {
			providerService.registerProvider(instantiationService.createInstance(NativeCliAgent, id, config));
		}
	} catch (error) {
		logService.error('Failed to configure native CLI agents', error);
	}
}

/**
 * The installed ZCode desktop application whose bundled CLI entry can be run directly. macOS keeps it in
 * `/Applications`. Elsewhere `zcode` on PATH is a launcher for the Electron binary, and the real directory it leads
 * to holds `resources`. The first `zcode` on PATH decides, as in a shell.
 */
async function installedZcode(env: NodeJS.ProcessEnv, exists: (path: string) => Promise<boolean>): Promise<{ readonly executable: string; readonly resources: string } | undefined> {
	if (process.platform === 'darwin') {
		const resources = '/Applications/ZCode.app/Contents/Resources';
		return await exists(join(resources, 'glm/zcode.cjs')) ? { executable: '/Applications/ZCode.app/Contents/MacOS/ZCode', resources } : undefined;
	}
	if (process.platform === 'win32') { return undefined; }
	for (const directory of (env.PATH ?? '').split(delimiter)) {
		const launcher = join(directory || '.', 'zcode');
		let executable: string;
		try { await fs.access(launcher, constants.X_OK); executable = await fs.realpath(launcher); } catch { continue; }
		const resources = join(dirname(executable), 'resources');
		return await exists(join(resources, 'glm/zcode.cjs')) && await exists(join(resources, 'config/provider/zcode-builtin.json')) ? { executable, resources } : undefined;
	}
	return undefined;
}

/** Builds a native launch without modifying either application's configuration. */
export async function nativeCliLaunch(id: NativeCliAgentId, config: INativeCliAgentConfig, cwd: string, inherited: NodeJS.ProcessEnv = process.env): Promise<INativeCliLaunch> {
	// The user's environment, without VS Code's and Electron's own process plumbing. The Claude and Copilot providers do the same.
	const env = { ...inherited };
	sanitizeProcessEnvironment(env);
	delete env.NODE_OPTIONS;
	const exists = async (path: string): Promise<boolean> => { try { await fs.access(path); return true; } catch { return false; } };
	if (config.executable === process.execPath) { env.ELECTRON_RUN_AS_NODE = '1'; }
	if (id === 'dsh') {
		if (config.home) { env.DSH_HOME = config.home; }
		const bundled = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
		return { executable: config.executable || (process.platform === 'darwin' && await exists(bundled) ? bundled : 'dsh'), args: config.args.length ? config.args : ['--profile', 'sdk'], env, cwd, jsonrpc: true };
	}
	if (config.home) { env.ZCODE_DATA_BASE_DIR = config.home; }
	const installed = config.executable ? undefined : await installedZcode(env, exists);
	if (installed) {
		env.ELECTRON_RUN_AS_NODE = '1';
		// The desktop's flattened CLI location needs explicit provider paths.
		const base = env.ZCODE_DATA_BASE_DIR || homedir();
		const builtin = join(installed.resources, 'config/provider/zcode-builtin.json');
		env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE ??= builtin;
		env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE ??= join(base, '.zcode/v2/provider_config.json');
		return { executable: installed.executable, args: [join(installed.resources, 'glm/zcode.cjs'), ...(config.args.length ? config.args : ['app-server', '--stdio'])], env, cwd, jsonrpc: false, ...(env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE === builtin ? { installedProviderConfig: builtin } : {}) };
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
	private readonly customizationsChanged = this._register(new Emitter<void>());
	readonly onDidCustomizationsChange = this.customizationsChanged.event;
	private readonly catalog = observableValue<readonly IAgentModelInfo[]>(this, []);
	readonly models = this.catalog;
	private readonly entries = new Map<string, IChat>();
	private readonly permissions = new Map<string, { chat: IChat; deferred: DeferredPromise<unknown>; method: string }>();
	private shutdownTask: Promise<void> | undefined;
	private closing = false;
	private readonly catalogAbort = new AbortController();
	private readonly customizationRequests = new Map<string, Promise<readonly Customization[]>>();
	/** Throwaway inspections by workspace (and model), shared by the permission catalog and every idle chat. */
	private readonly inventories = new Map<string, { expires: number; readonly snapshot: Promise<NativeRecord> }>();
	private readonly discoveries = this._register(new Limiter<unknown>(nativeDiscoveryConcurrency));
	private defaultModel: ModelSelection | undefined;
	private catalogLoad: Promise<void> | undefined;
	private catalogFailedAt: number | undefined;
	private permissionCatalog: INativeCliPermissions | undefined;
	private permissionsLoad: Promise<void> | undefined;
	private permissionsFailedAt: number | undefined;
	private permissionsObservable = true;

	constructor(
		readonly id: NativeCliAgentId,
		private readonly config: INativeCliAgentConfig,
		@ISessionDataService private readonly dataService: ISessionDataService,
		@ILogService private readonly logService: ILogService,
		@INativeEnvironmentService private readonly environmentService: INativeEnvironmentService,
		@IAgentConfigurationService private readonly agentConfigurationService: IAgentConfigurationService,
	) {
		super();
		this._register(toDisposable(() => this.catalogAbort.abort()));
		if (config.models.length) {
			this.catalog.set(config.models.map(model => ({ ...model, provider: id, supportsVision: false })), undefined);
			this.defaultModel = { id: config.models[0].id };
		}
		// Warm both catalogs in the background. Callers wait on the same bounded, retryable promises.
		void this.ensurePermissions();
		void this.ensureCatalog();
	}

	/** How long one native inspection may run before it is abandoned. */
	protected get discoveryTimeoutMs(): number { return nativeDiscoveryTimeoutMs; }

	/** Cancelled by shutdown, and by the deadline so that a hung native process cannot hold a caller forever. */
	private discoverySignal(): AbortSignal {
		return AbortSignal.any([this.catalogAbort.signal, AbortSignal.timeout(this.discoveryTimeoutMs)]);
	}

	/** Inspections start the whole native runtime, so a few run at a time and the rest wait their turn. */
	private discover<T>(task: () => Promise<T>): Promise<T> {
		return this.discoveries.queue(task) as Promise<T>;
	}

	/**
	 * Inspects a workspace in a throwaway native runtime. One result per workspace (and model) is kept for a few
	 * minutes and shared with concurrent callers, so republishing customizations never relaunches the CLI.
	 */
	private discoverSnapshot(cwd: string, modelSelection?: NativeRecord): Promise<NativeRecord> {
		const key = `${cwd}\n${modelSelection ? JSON.stringify(modelSelection) : ''}`;
		const now = Date.now();
		for (const [other, cached] of this.inventories) {
			if (cached.expires <= now) { this.inventories.delete(other); }
		}
		const known = this.inventories.get(key);
		if (known) { return known.snapshot; }
		const snapshot = this.discover(async () => discoverNativeCliRuntimeSnapshot(this.id, await nativeCliLaunch(this.id, this.config, cwd), this.discoverySignal(), modelSelection));
		// Callers that arrive while the inspection runs share it. Once it settles it is kept for a while, unless it
		// failed or reported itself incomplete: the next caller inspects again.
		const entry = { expires: Number.POSITIVE_INFINITY, snapshot };
		this.inventories.set(key, entry);
		const settle = (keep: boolean) => {
			if (keep) { entry.expires = Date.now() + nativeInventoryTtlMs; }
			else if (this.inventories.get(key) === entry) { this.inventories.delete(key); }
		};
		void snapshot.then(result => settle(result.complete !== false), () => settle(false));
		return snapshot;
	}

	/** Resolves once the permission catalog is known or could not be read. A failure is retried by the first demand after a pause. */
	private ensurePermissions(): Promise<void> {
		if (this.permissionCatalog || !this.permissionsObservable || this.closing) { return Promise.resolve(); }
		if (this.permissionsLoad) { return this.permissionsLoad; }
		if (this.permissionsFailedAt !== undefined && Date.now() - this.permissionsFailedAt < nativeDiscoveryRetryMs) { return Promise.resolve(); }
		const load = this.loadPermissions().finally(() => { if (this.permissionsLoad === load) { this.permissionsLoad = undefined; } });
		return this.permissionsLoad = load;
	}

	private async loadPermissions(): Promise<void> {
		try {
			const home = this.environmentService.userHome.fsPath;
			// Only the bundled runtimes can be observed; any other CLI offers no permission choices.
			if (!canObserveNativeCliRuntime(await nativeCliLaunch(this.id, this.config, home))) { this.permissionsObservable = false; return; }
			const snapshot = await this.discoverSnapshot(home);
			const catalog = readNativeCliPermissions(snapshot);
			if (!this.closing) {
				this.permissionCatalog = catalog;
				// A runtime that lists no modes has none to offer, and asking again cannot change that. Any other
				// answer that is not a catalog was not read, and is tried again after a pause.
				if (!catalog && offersNoNativeCliPermissions(snapshot)) { this.permissionsObservable = false; }
				this.permissionsFailedAt = catalog || !this.permissionsObservable ? undefined : Date.now();
			}
		} catch (error) {
			this.permissionsFailedAt = Date.now();
			if (!this.closing) { this.logService.warn(`Native permission catalog unavailable (${this.id}): ${describeFailure(error)}`); }
		}
	}

	/** Resolves once the model catalog is known or could not be read. A failure is retried by the first demand after a pause. */
	private ensureCatalog(): Promise<void> {
		if (this.defaultModel || this.closing) { return Promise.resolve(); }
		if (this.catalogLoad) { return this.catalogLoad; }
		if (this.catalogFailedAt !== undefined && Date.now() - this.catalogFailedAt < nativeDiscoveryRetryMs) { return Promise.resolve(); }
		const load = this.loadModelCatalog().finally(() => { if (this.catalogLoad === load) { this.catalogLoad = undefined; } });
		return this.catalogLoad = load;
	}

	private async loadModelCatalog(): Promise<void> {
		try {
			const catalog = await this.discover(async () => discoverNativeCliModels(this.id, await nativeCliLaunch(this.id, this.config, this.environmentService.userHome.fsPath), this.discoverySignal()));
			if (this.closing) { return; }
			this.defaultModel = catalog.defaultModel;
			this.catalog.set(catalog.models, undefined);
			this.catalogFailedAt = catalog.defaultModel ? undefined : Date.now();
		} catch (error) {
			this.catalogFailedAt = Date.now();
			// CLI configuration dumps can contain credentials, so a failure is logged by class only, never by its output.
			if (!this.closing) { this.logService.warn(`Native model catalog unavailable (${this.id}): ${describeFailure(error)}`); }
		}
	}

	getDescriptor() {
		return { provider: this.id, displayName: nativeCliAgentDisplayName(this.id), description: localize('nativeCli.description', "Agent running in a local native CLI process"), capabilities: { multipleChats: {} } };
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
		await Promise.all([this.ensureCatalog(), this.ensurePermissions()]);
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
		if (!model) { throw new Error(localize('nativeCli.modelsUnavailable', "Could not read the {0} model catalog. Check its native provider configuration and try again.", this.id)); }
		const permissionMode = resolveNativeCliPermissionConfig(this.id, this.permissionCatalog, options?.config).values[nativeCliPermissionModeKey(this.id)];
		const entry = this.newEntry(chat, context.resource, { version: 1, provider: this.id, nativeId: this.id === 'zcode' ? `sess_${generateUuid()}` : generateUuid(), cwd, model, workspaceless, persisted: false, createdAt: Date.now(), modifiedAt: Date.now() });
		if (typeof permissionMode === 'string') { entry.backing.permissionMode = permissionMode; }
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
				// JSON drops an undefined `usage`, while a live turn keeps the key. A restored turn must equal the live one.
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
		// A failed write is logged here and never rejects the chain: the turn it belongs to has already finished.
		entry.write = entry.write.then(async () => {
			const ref = this.dataService.openDatabase(entry.resource);
			try { await ref.object.setMetadata(this.historyKey(entry.uri), text); } finally { ref.dispose(); }
		}).catch(error => this.logService.error('Native agent transcript persistence failed', error));
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
			if (launch.installedProviderConfig) {
				temporary = await fs.mkdtemp(join(tmpdir(), 'vscode-zcode-provider-'));
				try {
					const copy = join(temporary, 'zcode-builtin.json');
					await fs.copyFile(launch.installedProviderConfig, copy);
					launch.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = copy;
				} catch (error) { await fs.rm(temporary, { recursive: true, force: true }); throw error; }
			}
			let observer: INativeCliObservedLaunch | undefined;
			let connection: NativeCliTransport;
			try {
				if (entry.generation !== generation || entry.disposed || this.closing) { throw new CancellationError(); }
				observer = canObserveNativeCliRuntime(launch) ? await observeNativeCliRuntime(this.id, launch) : undefined;
				if (entry.generation !== generation || entry.disposed || this.closing) { throw new CancellationError(); }
				connection = new NativeCliTransport(observer?.launch ?? launch);
			} catch (error) {
				observer?.dispose();
				if (temporary) { await fs.rm(temporary, { recursive: true, force: true }); }
				throw error;
			}
			entry.process = connection;
			const store = entry.processStore = new DisposableStore();
			store.add(connection);
			if (observer) { store.add(observer); }
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
					try {
						await connection.request(entry.backing.persisted ? 'session/resume' : 'session/working-directory/get', { sessionId: entry.backing.nativeId });
					} catch (error) {
						// A session that never completed a turn may not have been saved. Starting it again loses nothing.
						if (!entry.backing.persisted || hasCompletedTurn(entry)) { throw error; }
						await connection.request('session/working-directory/get', { sessionId: entry.backing.nativeId });
					}
				} else {
					await connection.request('runtime/capabilities', {});
					// Discover the native model defaults before selecting a route: ZCode
					// requires an explicit thinking level for some configured models.
					const session = { sessionId: entry.backing.nativeId, workspace: { workspacePath: entry.backing.cwd, workspaceKey: entry.backing.cwd } };
					let snapshot: NativeRecord;
					try {
						snapshot = record(await connection.request(entry.backing.persisted ? 'session/resume' : 'session/create', { ...session, ...(entry.backing.persisted ? {} : { mode: 'build' }) }));
					} catch (error) {
						// ZCode only keeps a session that has been used. Starting over loses nothing when no turn ever completed.
						if (!entry.backing.persisted || hasCompletedTurn(entry)) { throw error; }
						snapshot = record(await connection.request('session/create', { ...session, mode: 'build' }));
					}
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
		if (!discovered.length) { return; }
		if (!this.config.models.length) {
			this.catalog.set(discovered, undefined);
			return;
		}
		// An explicit model list keeps its own choices and names, even for a model the runtime does not list. The runtime
		// only adds what it knows about each one, such as its thinking levels.
		const known = new Map(discovered.map(model => [model.id, model]));
		this.catalog.set(this.config.models.map(({ id, name }) => ({ supportsVision: false, ...known.get(id), id, name, provider: this.id })), undefined);
	}

	private async send(chat: URI, prompt: string, turnId: string, roots: readonly URI[] | undefined, context: IAgentChatContext): Promise<void> {
		const entry = this.require(chat);
		// Stop and a crash leave the chat busy until its process has exited. Admitting a message sooner would be
		// refused as still running (DSH) or silently cancelled by the exit (ZCode).
		while (entry.stopping) {
			await entry.stopping.catch(() => { });
			this.require(chat);
		}
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
			await this.ensurePermissions();
			if (entry.generation !== generation || entry.active !== turn || entry.stopping || this.closing) { throw new CancellationError(); }
			const values = this.agentConfigurationService.getChatConfigValues({ session: context.owner.get().toString(), chat: chat.toString() });
			const permissionKey = nativeCliPermissionModeKey(this.id);
			const requestedMode = values?.[permissionKey] ?? entry.backing.permissionMode;
			// A chat that was given a mode must never fall back to the runtime's own default, for example because
			// the catalog could not be read in time. A runtime that cannot report modes at all never offered any.
			if (typeof requestedMode === 'string' && !this.permissionCatalog && this.permissionsObservable) { throw new Error(localize('nativeCli.permissions.unavailable', "The native runtime has not reported its permission modes, so the mode chosen for this chat cannot be applied. Try again in a moment.")); }
			const permissionConfig = resolveNativeCliPermissionConfig(this.id, this.permissionCatalog, { ...values, [permissionKey]: requestedMode ?? this.permissionCatalog?.defaultMode });
			const permissionMode = permissionConfig.values[permissionKey];
			const connection = await this.ensureProcess(entry);
			if (entry.generation !== generation || entry.active !== turn || entry.stopping) { throw new CancellationError(); }
			if (typeof permissionMode === 'string') {
				const applied = record(await connection.request('vscode/setPermissionMode', { sessionId: entry.backing.nativeId, mode: permissionMode }));
				if (applied.mode !== permissionMode) { throw new Error(localize('nativeCli.permissions.notApplied', "The native runtime did not apply the selected permission mode.")); }
				entry.backing.permissionMode = permissionMode;
			}
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
			this.customizationsChanged.fire();
		}
	}

	private notification(entry: IChat, connection: NativeCliTransport, method: string, params: NativeRecord): void {
		if (entry.process === connection && !entry.stopping && method === 'vscode/runtimeInventoryChanged' && params.sessionId === entry.backing.nativeId) {
			this.customizationsChanged.fire();
			return;
		}
		if (entry.process !== connection || entry.stopping || !entry.active) { return; }
		if (this.id === 'dsh' && method === 'session.event' && params.sessionId === entry.backing.nativeId) {
			const event = record(params.event);
			entry.active.dsh(event);
			if (event.type === 'turn/end') {
				const reason = record(record(event.data).reason);
				if (reason.kind === 'error' || reason.kind === 'failed') { void entry.completion?.error(new Error(String(reason.message ?? localize('nativeCli.dshFailed', "DeepSeek Harness turn failed.")))); }
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
			turn.tool(id, String(params.toolName ?? 'tool'), params.input, true, typeof params.reason === 'string' && params.reason ? params.reason : undefined);
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

	async resolveChatConfig(params: IAgentResolveChatConfigParams = {}) {
		await this.ensurePermissions();
		return resolveNativeCliPermissionConfig(this.id, this.permissionCatalog, params.config);
	}
	getInheritedChatConfig() { return undefined; }
	async chatConfigCompletions() { return { items: [] }; }
	async getChatCustomizations(chat: URI, context: URI | IAgentChatContext): Promise<readonly Customization[]> {
		if (this.closing) { throw new CancellationError(); }
		const resolved = resolveAgentChatContext(context, chat);
		// Discovery also serves ambient/draft scopes. Never provision a backing or
		// create a scratch folder just to inspect the native customization registry.
		const cwd = this.entries.get(chat.toString())?.backing.cwd ?? resolved.launchWorkingDirectories?.find(root => root.scheme === 'file')?.fsPath ?? this.environmentService.userHome.fsPath;
		const entry = this.entries.get(chat.toString());
		const key = chat.toString();
		let request = this.customizationRequests.get(key);
		if (!request) {
			request = entry?.process
				? (async () => {
					const connection = entry.process!;
					let snapshot: NativeRecord;
					try { snapshot = record(await connection.request('vscode/runtimeInventory', { sessionId: entry.backing.nativeId, ...(this.id === 'zcode' ? { modelSelection: this.zcodeModel(entry.backing.model) } : {}) }, 15_000)); }
					catch {
						if (this.id === 'dsh') { return nativeCliCustomizations(this.id, await this.discoverSnapshot(cwd)); }
						const skills = record(await connection.request('skills/referenceCatalog', { workspace: { workspacePath: cwd, workspaceKey: cwd } }, 15_000));
						snapshot = { ...skills, scope: 'chat', tools: [], toolsState: 'unavailable' };
					}
					if (this.id === 'zcode') { snapshot.plugins = record(await connection.request('plugins/list', { workspace: { workspacePath: cwd, workspaceKey: cwd } }, 15_000)).plugins; }
					if (entry.process !== connection || entry.stopping || this.closing) { throw new CancellationError(); }
					return nativeCliCustomizations(this.id, snapshot);
				})()
				: (async () => nativeCliCustomizations(this.id, await this.discoverSnapshot(cwd, this.id === 'zcode' && entry ? this.zcodeModel(entry.backing.model) : undefined)))();
			this.customizationRequests.set(key, request);
		}
		try { return await request; }
		finally { if (this.customizationRequests.get(key) === request) { this.customizationRequests.delete(key); } }
	}
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
		return this.shutdownTask ??= Promise.all([this.catalogLoad, this.permissionsLoad, ...[...this.customizationRequests.values()].map(request => request.catch(() => { })), ...[...this.entries.values()].map(async entry => { await this.stop(entry); await entry.write; })]).then(() => { });
	}
	override dispose(): void { void this.shutdown(); super.dispose(); }
}
