/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import sinon from 'sinon';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { upcastPartial } from '../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { INativeEnvironmentService } from '../../../environment/common/environment.js';
import { NullLogService } from '../../../log/common/log.js';
import { type IAgentChatContext, fixedChatOwnerRef } from '../../common/agent.js';
import { type INativeCliAgentConfig } from '../../common/nativeCliAgentConfig.js';
import { TurnState } from '../../common/state/sessionState.js';
import { IAgentConfigurationService } from '../../node/agentConfigurationService.js';
import { NativeCliAgent } from '../../node/nativeCli/nativeCliAgent.js';
import { TestSessionDatabase, createSessionDataService } from '../common/sessionTestHelpers.js';

// One executable that plays both roles of the DSH CLI: the throwaway inspection process (recognised by the
// result file it is asked to write) and the live protocol server. Every launch is appended to a log file.
const fixture = String.raw`
const fs = require('fs'), readline = require('readline');
const mode = process.env.VSCODE_NATIVE_INVENTORY_RESULT ? 'inventory' : 'live';
if (process.env.NATIVE_FIXTURE_LOG) { fs.appendFileSync(process.env.NATIVE_FIXTURE_LOG, mode + '\n'); }
if (mode === 'inventory') {
	if (process.env.NATIVE_FIXTURE_HANG) { setInterval(() => { }, 1000); }
	else {
		const modes = [{ id: 'read-only', name: 'Read Only' }, { id: 'workspace-write', name: 'Workspace Access' }];
		fs.writeFileSync(process.env.VSCODE_NATIVE_INVENTORY_RESULT, JSON.stringify({ complete: process.env.NATIVE_FIXTURE_INCOMPLETE ? false : true, skills: [], tools: [], scope: 'workspace', permissions: { options: modes, defaultMode: 'workspace-write' } }));
		process.stderr.write('VSCODE_NATIVE_INVENTORY_READY\n');
		process.stdin.resume();
	}
} else {
	let session, seq = 0, waiter, done = false;
	const send = value => process.stdout.write(JSON.stringify(value) + '\n');
	const event = (type, data) => send({ method: 'session.event', params: { sessionId: session, event: { seq: ++seq, type, data } } });
	readline.createInterface({ input: process.stdin }).on('line', line => {
		const m = JSON.parse(line), p = m.params || {};
		switch (m.method) {
			case 'initialize': send({ id: m.id, result: {} }); break;
			case 'session/working-directory/get': case 'session/resume': session = p.sessionId; send({ id: m.id, result: {} }); break;
			case 'vscode/setPermissionMode': send({ id: m.id, result: { mode: p.mode } }); break;
			case 'vscode/runtimeInventory': send({ id: m.id, result: { complete: true, skills: [], tools: [], scope: 'chat' } }); break;
			case 'session/prompt':
				send({ id: m.id, result: { messageId: 'm' } });
				event('assistant/message', { message: { content: [{ type: 'text', text: 'ok' }] } });
				event('turn/end', { reason: { kind: 'end-turn' } });
				done = true; if (waiter) { send({ id: waiter, result: {} }); }
				break;
			case 'session/wait': if (done) { send({ id: m.id, result: {} }); } else { waiter = m.id; } break;
			default: send({ id: m.id, error: { message: 'unknown method' } });
		}
	});
}
`;

/** A short deadline keeps the hung-process tests fast without changing what they prove. */
class ImpatientNativeCliAgent extends NativeCliAgent {
	protected override get discoveryTimeoutMs(): number { return 400; }
}

class RecordingLogService extends NullLogService {
	readonly warnings: string[] = [];
	override warn(message: string | Error): void { this.warnings.push(String(message)); }
}

function context(chat: URI, directory: string | undefined): IAgentChatContext {
	return { resource: chat, owner: fixedChatOwnerRef(URI.parse('ahp-session:/test')), sessionSettings: undefined, launchWorkingDirectories: directory ? [URI.file(directory)] : undefined, workspaceless: !directory };
}

suite('Native CLI agent discovery', () => {
	const store = new DisposableStore();
	const database = new TestSessionDatabase();
	const data = createSessionDataService(database);
	const config: INativeCliAgentConfig = { enabled: true, executable: process.execPath, args: ['-e', fixture, '--', '--profile', 'sdk'], home: '', models: [{ id: 'fixture/one', name: 'Fixture Model' }] };
	let root: string;
	let launchLog: string;
	let chosenMode: string | undefined;
	let log: RecordingLogService;
	const folders: string[] = [];
	const providers: NativeCliAgent[] = [];

	setup(async () => {
		root = await fs.mkdtemp(join(tmpdir(), 'native-cli-discovery-'));
		launchLog = join(root, 'launches.log');
		await fs.writeFile(launchLog, '');
		process.env.NATIVE_FIXTURE_LOG = launchLog;
		chosenMode = undefined;
		log = new RecordingLogService();
		folders.length = 0;
	});

	teardown(async () => {
		delete process.env.NATIVE_FIXTURE_LOG;
		delete process.env.NATIVE_FIXTURE_HANG;
		delete process.env.NATIVE_FIXTURE_INCOMPLETE;
		await Promise.all(providers.splice(0).map(provider => provider.shutdown()));
		store.clear();
		await fs.rm(root, { recursive: true, force: true });
	});
	suiteTeardown(() => { database.dispose(); store.dispose(); });
	ensureNoDisposablesAreLeakedInTestSuite();

	function agent(type: typeof NativeCliAgent = NativeCliAgent, agentConfig: INativeCliAgentConfig = config): NativeCliAgent {
		const provider = store.add(new type('dsh', agentConfig, data, log, { userHome: URI.file(root) } as INativeEnvironmentService, upcastPartial<IAgentConfigurationService>({ getChatConfigValues: () => chosenMode ? { 'dsh.permissionMode': chosenMode } : undefined })));
		providers.push(provider);
		return provider;
	}

	async function folder(name: string): Promise<string> {
		const directory = join(root, name);
		await fs.mkdir(directory, { recursive: true });
		folders.push(directory);
		return directory;
	}

	async function launches(kind: 'inventory' | 'live'): Promise<number> {
		return (await fs.readFile(launchLog, 'utf8')).split('\n').filter(line => line === kind).length;
	}

	async function create(provider: NativeCliAgent, name: string, directory: string): Promise<{ chat: URI; ctx: IAgentChatContext }> {
		const chat = URI.parse(`ahp-chat:/${name}`);
		const ctx = context(chat, directory);
		await provider.chats.createChat(chat, ctx, { workingDirectories: [URI.file(directory)] });
		return { chat, ctx };
	}

	test('republishing after a turn reuses the inspection of idle chats instead of relaunching the runtime', async () => {
		const provider = agent();
		const [a, b, c] = [await folder('a'), await folder('b'), await folder('c')];
		const idleB = await create(provider, 'b', b);
		const idleC = await create(provider, 'c', c);
		const busy = await create(provider, 'a', a);
		await provider.getChatCustomizations(idleB.chat, idleB.ctx);
		await provider.getChatCustomizations(idleC.chat, idleC.ctx);
		await provider.chats.sendMessage(busy.chat, 'go', [URI.file(a)], undefined, 'turn', undefined, busy.ctx);

		const before = await launches('inventory');
		// What Agent Host does when the agent reports that a turn ended: refetch every session of the agent.
		for (const chat of [busy, idleB, idleC]) { await provider.getChatCustomizations(chat.chat, chat.ctx); }
		assert.strictEqual(await launches('inventory'), before, 'idle chats must not launch the native runtime again');
		assert.strictEqual(await launches('live'), 1, 'only the chat that ran a turn owns a runtime');
	});

	test('chats in one workspace share a single inspection, and its result expires', async () => {
		const clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
		try {
			const provider = agent();
			const shared = await folder('shared');
			const one = await create(provider, 'one', shared);
			const two = await create(provider, 'two', shared);
			await provider.resolveChatConfig();
			const before = await launches('inventory');
			await Promise.all([provider.getChatCustomizations(one.chat, one.ctx), provider.getChatCustomizations(two.chat, two.ctx)]);
			assert.strictEqual(await launches('inventory') - before, 1);
			clock.tick(6 * 60_000);
			await provider.getChatCustomizations(one.chat, one.ctx);
			assert.strictEqual(await launches('inventory') - before, 2, 'a stale inspection is refreshed');
		} finally {
			clock.restore();
		}
	});

	test('the permission catalog and a draft chat share the startup inspection', async () => {
		const provider = agent();
		await provider.resolveChatConfig();
		const draft = URI.parse('ahp-chat:/draft');
		await provider.getChatCustomizations(draft, context(draft, undefined));
		assert.strictEqual(await launches('inventory'), 1);
	});

	test('a hung inspection cannot block chat creation, is logged by class only and is retried later', async () => {
		const clock = sinon.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
		try {
			process.env.NATIVE_FIXTURE_HANG = '1';
			const provider = agent(ImpatientNativeCliAgent);
			const started = performance.now();
			const directory = await folder('hung');
			const { chat, ctx } = await create(provider, 'hung', directory);
			assert.ok(performance.now() - started < 10_000, 'creation waited for a hung runtime');
			assert.deepStrictEqual(Object.keys((await provider.resolveChatConfig()).schema.properties ?? {}), [], 'no permission choices without a catalog');
			assert.strictEqual(log.warnings.length, 1);
			assert.match(log.warnings[0], /^Native permission catalog unavailable \(dsh\): /);
			assert.ok(!log.warnings[0].includes(root), 'the failure must not echo native command lines');

			delete process.env.NATIVE_FIXTURE_HANG;
			assert.deepStrictEqual(Object.keys((await provider.resolveChatConfig()).schema.properties ?? {}), [], 'a failure is not retried immediately');
			clock.tick(31_000);
			assert.deepStrictEqual(Object.keys((await provider.resolveChatConfig()).schema.properties ?? {}), ['dsh.permissionMode']);
			await provider.chats.sendMessage(chat, 'go', [URI.file(directory)], undefined, 'turn', undefined, ctx);
			assert.deepStrictEqual((await provider.chats.getMessages(chat, ctx)).map(turn => turn.state), [TurnState.Complete]);
		} finally {
			clock.restore();
		}
	});

	test('an incomplete inspection still yields permissions, but is refused for customizations and inspected again', async () => {
		process.env.NATIVE_FIXTURE_INCOMPLETE = '1';
		const provider = agent();
		// Permission modes do not depend on the skill scan that makes an inspection incomplete.
		assert.deepStrictEqual(Object.keys((await provider.resolveChatConfig()).schema.properties ?? {}), ['dsh.permissionMode']);
		const draft = URI.parse('ahp-chat:/incomplete');
		const before = await launches('inventory');
		await assert.rejects(provider.getChatCustomizations(draft, context(draft, undefined)), /incomplete/);
		await assert.rejects(provider.getChatCustomizations(draft, context(draft, undefined)), /incomplete/);
		assert.strictEqual(await launches('inventory') - before, 2, 'an incomplete inspection must not be reused');
		delete process.env.NATIVE_FIXTURE_INCOMPLETE;
		await provider.getChatCustomizations(draft, context(draft, undefined));
		await provider.getChatCustomizations(draft, context(draft, undefined));
		assert.strictEqual(await launches('inventory') - before, 3, 'a complete inspection is reused');
	});

	test('a runtime that cannot report permission modes still runs a chat that remembers one', async () => {
		const provider = agent(NativeCliAgent, { ...config, args: ['-e', fixture] });
		const directory = await folder('unobservable');
		const chat = URI.parse('ahp-chat:/unobservable');
		const ctx = context(chat, directory);
		const backing = JSON.stringify({ version: 1, provider: 'dsh', nativeId: 'native-session', cwd: directory, model: { id: 'fixture/one' }, persisted: false, createdAt: 1, modifiedAt: 1, permissionMode: 'read-only' });
		await provider.materializeChat(chat, ctx, backing);
		await provider.chats.sendMessage(chat, 'go', [URI.file(directory)], undefined, 'turn', undefined, ctx);
		assert.deepStrictEqual((await provider.chats.getMessages(chat, ctx)).map(turn => turn.state), [TurnState.Complete]);
		assert.strictEqual(await launches('inventory'), 0, 'a runtime that cannot be observed is never inspected');
	});

	test('a chat with a chosen permission mode never runs under the runtime default when the catalog is unavailable', async () => {
		process.env.NATIVE_FIXTURE_HANG = '1';
		const provider = agent(ImpatientNativeCliAgent);
		const directory = await folder('guarded');
		const chat = URI.parse('ahp-chat:/guarded');
		const ctx = context(chat, directory);
		const backing = JSON.stringify({ version: 1, provider: 'dsh', nativeId: 'native-session', cwd: directory, model: { id: 'fixture/one' }, persisted: false, createdAt: 1, modifiedAt: 1, permissionMode: 'read-only' });
		await provider.materializeChat(chat, ctx, backing);
		await assert.rejects(provider.chats.sendMessage(chat, 'go', [URI.file(directory)], undefined, 'turn', undefined, ctx), /permission modes/);
		assert.strictEqual(await launches('live'), 0, 'the runtime must not be started without the chosen mode');
	});
});
