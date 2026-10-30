/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { upcastPartial } from '../../../../base/test/common/mock.js';
import { IAgentConfigurationService } from '../../node/agentConfigurationService.js';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { DeferredPromise } from '../../../../base/common/async.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { INativeEnvironmentService } from '../../../environment/common/environment.js';
import { type IAgentActionSignal, type IAgentChatContext, fixedChatOwnerRef } from '../../common/agent.js';
import { nativeCliAgentEnv, type INativeCliAgentConfig, type NativeCliAgentId } from '../../common/nativeCliAgentConfig.js';
import { ActionType, type IToolCallReadyAction } from '../../common/state/sessionActions.js';
import { MessageKind, ResponsePartKind, ToolCallConfirmationReason, ToolCallStatus, TurnState, type Turn } from '../../common/state/sessionState.js';
import { NativeCliAgent, nativeCliLaunch, readNativeCliAgentConfigs } from '../../node/nativeCli/nativeCliAgent.js';
import { NativeCliTransport } from '../../node/nativeCli/nativeCliTransport.js';
import { NativeCliTurn } from '../../node/nativeCli/nativeCliTurn.js';
import { TestSessionDatabase, createSessionDataService } from '../common/sessionTestHelpers.js';

// A real subprocess implementing both dialects; no account, inference or disk database.
const fixture = String.raw`
const readline = require('readline');
let session, restored = false, seq = 0, waiter, done = false, creation;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const event = (type, payload) => send({method:'session/event',params:{sessionId:session,eventId:String(++seq),type,payload}});
const dsh = (type,data) => send({method:'session.event',params:{sessionId:session,event:{seq:++seq,type,data}}});
const finish = (text, dialect) => {
 if (dialect === 'dsh') { dsh('assistant/message',{message:{content:[{type:'text',text}]}}); dsh('turn/end',{reason:{kind:'end-turn'}}); done=true; if(waiter)send({id:waiter,result:{}}); }
 else { event('part.delta',{partId:'answer',field:'text',delta:text}); event('part.upserted',{part:{partId:'answer',type:'text',text}}); event('turn.completed',{response:text,resultType:'success'}); }
};
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line),p=m.params||{};
 if(!m.method) { if(m.id==='preferences'){send({id:creation,result:{settings:{model:{available:[{ref:{providerId:'fixture',modelId:'one'},label:'Fixture Model',reasoning:{levels:[{value:'off',label:'Off'}],defaultLevel:'off'}}]}}}});return;}finish(JSON.stringify(m.result),'dsh');return; }
 switch(m.method){
 case 'initialize':setTimeout(()=>send({id:m.id,result:{serverInfo:{name:'fixture'}}}),10);break;
 case 'runtime/capabilities':send({id:m.id,result:{historyFirst:true}});break;
 case 'session/create':case 'session/resume':case 'session/working-directory/get':
  session=p.sessionId;restored=m.method==='session/resume';
	if(process.env.NATIVE_FIXTURE_STORE&&restored&&!require('fs').existsSync(require('path').join(process.env.NATIVE_FIXTURE_STORE,session))){send({id:m.id,error:{message:'Session not found: '+session}});break;}
	if(!m.jsonrpc){creation=m.id;send({id:'preferences',method:'session/requestRuntimePreferences',params:{sessionId:session,scope:'runtime-materialization'}});break;}send({id:m.id,result:{settings:{model:{available:[{ref:{providerId:'fixture',modelId:'one'},label:'Fixture Model'}]}}}});break;
 case 'session/subscribe':send({id:m.id,result:{}});break;
 case 'session/prompt':case 'session/send': {
	  done=false;waiter=undefined;const dialect=m.method==='session/prompt'?'dsh':'zcode';
	if(process.env.NATIVE_FIXTURE_STORE)require('fs').writeFileSync(require('path').join(process.env.NATIVE_FIXTURE_STORE,session),'');
	  if(dialect==='dsh'&&!Array.isArray(p.contentBlocks)){send({id:m.id,error:{message:'contentBlocks required'}});break;}
	  const prompt=dialect==='dsh'?p.contentBlocks.map(b=>b.text||'').join(''):p.content;
  send({id:m.id,result:dialect==='dsh'?{messageId:'message'}:{accepted:true}});
	  if(prompt==='crash'){process.exit(2);break;}
	  if(prompt==='hold'){if(dialect==='dsh')dsh('assistant/message',{message:{content:[{type:'text',text:'waiting'}]}});else event('part.delta',{partId:'answer',field:'text',delta:'waiting'});break;}
	  if(prompt==='permission'){send({id:'permission',method:'approval/request',params:{sessionId:session,callId:'call-1',toolName:'write',reason:'Write /workspace/a.txt'}});break;}
  if(dialect==='dsh'&&prompt.startsWith('/output-style')){dsh('command/done',{commandId:'style',kind:prompt.endsWith('missing')?'error':'success',text:prompt.endsWith('missing')?'Unknown output style: missing':'Session style: concise'});dsh('turn/end',{reason:{kind:'completed'}});done=true;if(waiter)send({id:waiter,result:{}});break;}
  finish('pid='+process.pid+';resumed='+restored,dialect);break;
 }
 case 'session/wait':if(done)send({id:m.id,result:{}});else waiter=m.id;break;
 default:send({id:m.id,error:{message:'unknown method'}});
 }
});
`;

function context(chat: URI): IAgentChatContext {
	return { resource: chat, owner: fixedChatOwnerRef(URI.parse('ahp-session:/test')), sessionSettings: undefined, launchWorkingDirectories: [URI.file(tmpdir())], workspaceless: false };
}

function response(turn: Turn): string {
	return turn.responseParts.filter(part => part.kind === ResponsePartKind.Markdown).map(part => part.content).join('');
}

suite('Native CLI agents', () => {
	const store = new DisposableStore();
	const database = new TestSessionDatabase();
	const data = createSessionDataService(database);
	const config: INativeCliAgentConfig = { enabled: true, executable: process.execPath, args: ['-e', fixture], home: '', models: [{ id: 'fixture/one', name: 'Fixture Model' }] };

	teardown(() => store.clear());
	suiteTeardown(() => { database.dispose(); store.dispose(); });
	ensureNoDisposablesAreLeakedInTestSuite();

	function agent(id: NativeCliAgentId): NativeCliAgent {
		return store.add(new NativeCliAgent(id, config, data, new NullLogService(), { userHome: URI.file(tmpdir()) } as INativeEnvironmentService, upcastPartial<IAgentConfigurationService>({ getChatConfigValues: () => undefined })));
	}

	async function create(provider: NativeCliAgent, suffix: string): Promise<URI> {
		const chat = URI.parse(`ahp-chat:/${suffix}`);
		await provider.chats.createChat(chat, context(chat), { workingDirectories: [URI.file(tmpdir())] });
		return chat;
	}

	function send(provider: NativeCliAgent, chat: URI, text: string, id: string): Promise<void> {
		return provider.chats.sendMessage(chat, text, [URI.file(tmpdir())], undefined, id, undefined, context(chat));
	}

	for (const dialect of ['dsh', 'zcode'] as const) {
		test(`${dialect}: a workspaceless chat sends and resumes in its stable scratch folder`, async () => {
			const home = await fs.mkdtemp(join(tmpdir(), 'native-cli-workspaceless-'));
			const provider = store.add(new NativeCliAgent(dialect, config, data, new NullLogService(), { userHome: URI.file(home) } as INativeEnvironmentService, upcastPartial<IAgentConfigurationService>({ getChatConfigValues: () => undefined })));
			const chat = URI.parse(`ahp-chat:/${dialect}-workspaceless`);
			const ctx = { ...context(chat), launchWorkingDirectories: undefined, workspaceless: true };
			let project: unknown;
			store.add(provider.onDidMaterializeChat(event => { project = event.project; }));
			try {
				await provider.chats.createChat(chat, ctx);
				const scratch = (await provider.getChatMetadata(chat, ctx))?.workingDirectories?.[0].fsPath;
				assert.strictEqual(scratch, join(home, '.copilot/chats/test'));
				await provider.chats.sendMessage(chat, 'first', undefined, undefined, 'first', undefined, ctx);
				assert.strictEqual(project, undefined, 'A scratch folder must not become a workspace project');
				await provider.chats.releaseChat?.(chat, ctx);
				await fs.rm(scratch!, { recursive: true });
				await provider.chats.sendMessage(chat, 'resume', undefined, undefined, 'second', undefined, ctx);
				assert.deepStrictEqual((await provider.chats.getMessages(chat, ctx)).map(turn => turn.state), [TurnState.Complete, TurnState.Complete]);
			} finally {
				await provider.shutdown();
				await fs.rm(home, { recursive: true, force: true });
			}
		});

		test(`${dialect}: reuses its process across turns and preserves history across provider restart`, async () => {
			const provider = agent(dialect);
			const chat = await create(provider, `${dialect}-restore`);
			let backing: string | undefined;
			store.add(provider.onDidChangeChatData(event => { if (event.chat.toString() === chat.toString()) { backing = event.providerData; } }));
			await send(provider, chat, 'first', 'first');
			await send(provider, chat, 'second', 'second');
			const before = await provider.chats.getMessages(chat, context(chat));
			assert.strictEqual(response(before[0]), response(before[1]));
			await provider.shutdown();
			const restored = agent(dialect);
			await restored.materializeChat(chat, context(chat), backing);
			assert.deepStrictEqual(await restored.chats.getMessages(chat, context(chat)), before);
			await send(restored, chat, 'third', 'third');
			const after = await restored.chats.getMessages(chat, context(chat));
			assert.deepStrictEqual(after.map(turn => [turn.id, turn.state]), [['first', TurnState.Complete], ['second', TurnState.Complete], ['third', TurnState.Complete]]);
			assert.match(response(after[2]), /resumed=true/);
			await restored.shutdown();
		});
	}

	test('zcode: an explicit model list keeps its own choices once the runtime reports its catalog', async () => {
		const models = [{ id: 'mine/other', name: 'Mine' }, { id: 'fixture/one', name: 'Renamed' }];
		const provider = store.add(new NativeCliAgent('zcode', { ...config, models }, data, new NullLogService(), { userHome: URI.file(tmpdir()) } as INativeEnvironmentService, upcastPartial<IAgentConfigurationService>({ getChatConfigValues: () => undefined })));
		const chat = await create(provider, 'zcode-models');
		await send(provider, chat, 'first', 'first');
		// The runtime adds the thinking levels it knows for a listed model, and nothing is dropped or invented.
		assert.deepStrictEqual(provider.models.get().map(model => [model.id, model.name, !!model.configSchema]), [['mine/other', 'Mine', false], ['fixture/one', 'Renamed', true]]);
		await provider.shutdown();
	});

	test('stopping one chat leaves another process usable and the cancelled chat resumes', async () => {
		const provider = agent('dsh');
		const one = await create(provider, 'cancel-one');
		const two = await create(provider, 'cancel-two');
		const waiting = new DeferredPromise<void>();
		store.add(provider.onDidChatProgress(signal => {
			if (signal.kind === 'action' && signal.resource.toString() === one.toString() && signal.action.type === ActionType.ChatDelta) { void waiting.complete(); }
		}));
		const running = send(provider, one, 'hold', 'cancelled');
		await waiting.p;
		await send(provider, two, 'first', 'other-first');
		await provider.chats.abort(one, context(one));
		await running;
		await send(provider, two, 'second', 'other-second');
		await send(provider, one, 'continue', 'continued');
		const history = await provider.chats.getMessages(one, context(one));
		const other = await provider.chats.getMessages(two, context(two));
		assert.deepStrictEqual(history.map(turn => turn.state), [TurnState.Cancelled, TurnState.Complete]);
		assert.match(response(history[1]), /resumed=true/);
		assert.strictEqual(response(other[0]), response(other[1]));
		await provider.shutdown();
	});

	for (const dialect of ['dsh', 'zcode'] as const) {
		test(`${dialect}: a message sent right after Stop waits for the old process and is answered`, async () => {
			const provider = agent(dialect);
			const chat = await create(provider, `${dialect}-stop-then-send`);
			const streaming = new DeferredPromise<void>();
			store.add(provider.onDidChatProgress(signal => {
				if (signal.kind === 'action' && signal.resource.toString() === chat.toString() && signal.action.type === ActionType.ChatDelta) { void streaming.complete(); }
			}));
			const held = send(provider, chat, 'hold', 'held');
			await streaming.p;
			// The host does not await abort() before it admits the next message.
			void provider.chats.abort(chat, context(chat));
			await send(provider, chat, 'again', 'again');
			await held;
			const history = await provider.chats.getMessages(chat, context(chat));
			assert.deepStrictEqual(history.map(turn => turn.state), [TurnState.Cancelled, TurnState.Complete]);
			assert.match(response(history[1]), /resumed=true/);
			await provider.shutdown();
		});
	}

	test('cancellation before startup cannot admit a late prompt', async () => {
		const provider = agent('dsh');
		const chat = await create(provider, 'cancel-startup');
		const running = send(provider, chat, 'first', 'cancelled');
		await provider.chats.abort(chat, context(chat));
		await running;
		const history = await provider.chats.getMessages(chat, context(chat));
		assert.deepStrictEqual(history.map(turn => [turn.state, response(turn)]), [[TurnState.Cancelled, '']]);
		await send(provider, chat, 'second', 'second');
		await provider.shutdown();
	});

	test('native approval requests return the selected decision without completing the turn early', async () => {
		const provider = agent('dsh');
		const chat = await create(provider, 'permission');
		const asked: { title: unknown; input: unknown }[] = [];
		store.add(provider.onDidChatProgress(signal => {
			if (signal.kind === 'action' && signal.action.type === ActionType.ChatToolCallReady && !signal.action.confirmed) {
				asked.push({ title: signal.action.confirmationTitle, input: signal.action.toolInput });
				provider.respondToPermissionRequest(signal.action.toolCallId, false);
			}
		}));
		await send(provider, chat, 'permission', 'permission-turn');
		const turns = await provider.chats.getMessages(chat, context(chat));
		assert.match(response(turns[0]), /rejected/);
		// The request names why it needs a decision. It must not carry a made-up input over the one the call already showed.
		assert.deepStrictEqual(asked, [{ title: 'Write /workspace/a.txt', input: undefined }]);
		await provider.shutdown();
	});

	test('DSH local command results render and remain in restored history without an assistant message', async () => {
		const provider = agent('dsh');
		const chat = await create(provider, 'commands');
		let backing: string | undefined;
		store.add(provider.onDidChangeChatData(event => { if (event.chat.toString() === chat.toString()) { backing = event.providerData; } }));
		await send(provider, chat, '/output-style concise', 'style');
		await send(provider, chat, '/output-style missing', 'invalid');
		const before = await provider.chats.getMessages(chat, context(chat));
		assert.deepStrictEqual(before.map(turn => [turn.state, response(turn)]), [
			[TurnState.Complete, 'Session style: concise'],
			[TurnState.Complete, 'Unknown output style: missing'],
		]);
		await provider.shutdown();
		const restored = agent('dsh');
		await restored.materializeChat(chat, context(chat), backing);
		assert.deepStrictEqual(await restored.chats.getMessages(chat, context(chat)), before);
		await restored.shutdown();
	});

	test('ZCode committed text reconciles deltas without duplicating the final answer', () => {
		const turn = new NativeCliTurn(URI.parse('ahp-chat:/mapping'), 'turn', 'prompt', undefined, () => { });
		turn.zcode({ type: 'part.delta', payload: { partId: 'text', field: 'text', delta: 'hello' } });
		turn.zcode({ type: 'part.upserted', payload: { part: { type: 'text', partId: 'text', text: 'hello world' } } });
		turn.zcode({ type: 'turn.completed', payload: { response: 'hello world', resultType: 'success' } });
		assert.strictEqual(response(turn.turn), 'hello world');
	});

	test('a crashed native process can resume on the next send', async () => {
		const provider = agent('dsh');
		const chat = await create(provider, 'crash-recovery');
		await assert.rejects(send(provider, chat, 'crash', 'crashed'), /exited/);
		await send(provider, chat, 'continue', 'recovered');
		const turns = await provider.chats.getMessages(chat, context(chat));
		assert.deepStrictEqual(turns.map(turn => turn.state), [TurnState.Error, TurnState.Complete]);
		assert.match(response(turns[1]), /resumed=true/);
		await provider.shutdown();
	});

	test('ZCode stream identities reconcile a differently named committed part', () => {
		const turn = new NativeCliTurn(URI.parse('ahp-chat:/streaming'), 'turn', 'prompt', undefined, () => { });
		turn.zcode({ type: 'model.streaming', payload: { assistantMessageId: 'message', kind: 'text_delta', delta: 'hello' } });
		turn.zcode({ type: 'part.upserted', payload: { part: { type: 'text', messageId: 'message', partId: 'committed', text: 'hello world' } } });
		turn.zcode({ type: 'turn.completed', payload: { response: 'hello world', resultType: 'success' } });
		assert.deepStrictEqual(turn.turn.responseParts.map(part => part.kind === ResponsePartKind.Markdown ? part.content : part.kind), ['hello world']);
	});

	test('later updates of a tool call that awaits a decision do not announce it as running again', () => {
		const actions: IAgentActionSignal['action'][] = [];
		const turn = new NativeCliTurn(URI.parse('ahp-chat:/pending'), 'turn', 'prompt', undefined, signal => { if (signal.kind === 'action') { actions.push(signal.action); } });
		turn.tool('call', 'write', { path: 'a' });
		turn.tool('call', 'write', undefined, true, 'Write a');
		// ZCode repeats a call's state while the runtime waits for the answer.
		turn.zcode({ eventId: '1', type: 'part.upserted', payload: { part: { type: 'tool', callId: 'call', tool: 'write', state: { status: 'running', input: { path: 'b' } } } } });
		turn.zcode({ eventId: '2', type: 'tool.updated', payload: { toolCallId: 'call', kind: 'scheduled', toolName: 'write', input: { path: 'c' } } });
		assert.deepStrictEqual(actions.flatMap(action => action.type === ActionType.ChatToolCallReady ? [{ confirmed: action.confirmed, title: action.confirmationTitle, input: action.toolInput }] : []), [
			{ confirmed: ToolCallConfirmationReason.NotNeeded, title: undefined, input: '{"path":"a"}' },
			{ confirmed: undefined, title: 'Write a', input: undefined },
		]);
	});

	test('a tool call is announced again only when its input changes', () => {
		const inputs: IToolCallReadyAction['toolInput'][] = [];
		const turn = new NativeCliTurn(URI.parse('ahp-chat:/inputs'), 'turn', 'prompt', undefined, signal => { if (signal.kind === 'action' && signal.action.type === ActionType.ChatToolCallReady) { inputs.push(signal.action.toolInput); } });
		turn.tool('call', 'read');
		turn.tool('call', 'read', { path: 'a' });
		turn.tool('call', 'read', { path: 'a' });
		turn.tool('call', 'read');
		assert.deepStrictEqual(inputs, [undefined, '{"path":"a"}']);
	});

	test('dsh reports a tool call input as JSON text, which is not encoded a second time', () => {
		const inputs: IToolCallReadyAction['toolInput'][] = [];
		const turn = new NativeCliTurn(URI.parse('ahp-chat:/dsh-input'), 'turn', 'prompt', undefined, signal => { if (signal.kind === 'action' && signal.action.type === ActionType.ChatToolCallReady) { inputs.push(signal.action.toolInput); } });
		turn.dsh({ seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'call', name: 'bash', arguments: '{"command":"ls"}' }] } } });
		assert.deepStrictEqual(inputs, ['{"command":"ls"}']);
	});

	test('zcode shows the input of a tool call from its model stream, since the scheduled event omits it', () => {
		const inputs: IToolCallReadyAction['toolInput'][] = [];
		const turn = new NativeCliTurn(URI.parse('ahp-chat:/zcode-input'), 'turn', 'prompt', undefined, signal => { if (signal.kind === 'action' && signal.action.type === ActionType.ChatToolCallReady) { inputs.push(signal.action.toolInput); } });
		turn.zcode({ eventId: '1', type: 'model.streaming', payload: { kind: 'tool_call', toolCallId: 'call', toolName: 'Read', input: { file_path: '/a' } } });
		turn.zcode({ eventId: '2', type: 'tool.updated', payload: { kind: 'scheduled', toolCallId: 'call', toolName: 'Read', inputOmitted: true } });
		assert.deepStrictEqual(inputs, ['{"file_path":"/a"}']);
	});

	test('a tool call the runtime never reported on is not marked failed in a turn that completed', () => {
		const turn = new NativeCliTurn(URI.parse('ahp-chat:/dangling'), 'turn', 'prompt', undefined, () => { });
		turn.tool('call', 'read');
		turn.finish(TurnState.Complete);
		assert.deepStrictEqual(turn.turn.responseParts.map(part => part.kind === ResponsePartKind.ToolCall && part.toolCall.status === ToolCallStatus.Completed ? part.toolCall.success : part.kind), [true]);
	});

	test('preserves a UTF-8 code point split across protocol chunks', async () => {
		const script = `process.stdin.once('data',()=>{const b=Buffer.from(JSON.stringify({id:1,result:'你好🌱'})+'\\n');const p=b.indexOf(Buffer.from('🌱'))+1;process.stdout.write(b.subarray(0,p));setTimeout(()=>process.stdout.write(b.subarray(p)),5)})`;
		const transport = store.add(new NativeCliTransport({ executable: process.execPath, args: ['-e', script], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, cwd: tmpdir(), jsonrpc: true }));
		assert.strictEqual(await transport.request('unicode'), '你好🌱');
		await transport.shutdown();
	});

	test('a malformed provider configuration is reported and does not disable the other provider', () => {
		const invalid: string[] = [];
		const configs = readNativeCliAgentConfigs({ [nativeCliAgentEnv]: JSON.stringify({ dsh: { enabled: true, args: 'unsafe shell string' }, zcode: { enabled: true, models: [{ id: 'provider/model', name: 'Model' }] } }) }, (id, error) => invalid.push(`${id}: ${error.message}`));
		assert.deepStrictEqual({ registered: [...configs.keys()], invalid }, { registered: ['zcode'], invalid: ['dsh: Invalid dsh native agent launch configuration.'] });
		const badModel = readNativeCliAgentConfigs({ [nativeCliAgentEnv]: JSON.stringify({ dsh: { enabled: true, models: [{ id: '', name: 'x' }] }, zcode: { enabled: true } }) }, (id, error) => invalid.push(`${id}: ${error.message}`));
		assert.deepStrictEqual([...badModel.keys()], ['zcode']);
	});

	test('blank lines between protocol frames are not frames', async () => {
		const script = `process.stdin.once('data',()=>{process.stdout.write('\\n\\r\\n   \\n');process.stdout.write(JSON.stringify({id:1,result:'ok'})+'\\n')})`;
		const transport = store.add(new NativeCliTransport({ executable: process.execPath, args: ['-e', script], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, cwd: tmpdir(), jsonrpc: true }));
		assert.strictEqual(await transport.request('ping'), 'ok');
		await transport.shutdown();
	});

	test('a failed history write is logged and never fails the turn or shutdown', async () => {
		class FailingDatabase extends TestSessionDatabase {
			override async setMetadata(): Promise<void> { throw new Error('disk full'); }
		}
		const failing = new FailingDatabase();
		const errors: unknown[] = [];
		const log = new class extends NullLogService { override error(message: string | Error): void { errors.push(message); } }();
		const provider = store.add(new NativeCliAgent('dsh', config, createSessionDataService(failing), log, { userHome: URI.file(tmpdir()) } as INativeEnvironmentService, upcastPartial<IAgentConfigurationService>({ getChatConfigValues: () => undefined })));
		try {
			const chat = await create(provider, 'failing-write');
			const published: string[] = [];
			store.add(provider.onDidChangeChatData(event => published.push(event.chat.toString())));
			await send(provider, chat, 'first', 'first');
			assert.deepStrictEqual((await provider.chats.getMessages(chat, context(chat))).map(turn => turn.state), [TurnState.Complete]);
			assert.ok(published.includes(chat.toString()), 'the finished turn is still published');
			await provider.shutdown();
			assert.ok(errors.length > 0, 'the failure is logged');
		} finally {
			failing.dispose();
		}
	});

	for (const dialect of ['dsh', 'zcode'] as const) {
		test(`${dialect}: a persisted chat whose native session was never used starts over instead of failing forever`, async () => {
			const sessions = await fs.mkdtemp(join(tmpdir(), 'native-cli-sessions-'));
			process.env.NATIVE_FIXTURE_STORE = sessions;
			try {
				const provider = agent(dialect);
				const chat = URI.parse(`ahp-chat:/${dialect}-never-used`);
				await provider.materializeChat(chat, context(chat), JSON.stringify({ version: 1, provider: dialect, nativeId: 'sess_never_used', cwd: tmpdir(), model: { id: 'fixture/one' }, persisted: true, createdAt: 1, modifiedAt: 1 }));
				await send(provider, chat, 'first', 'first');
				const turns = await provider.chats.getMessages(chat, context(chat));
				assert.deepStrictEqual(turns.map(turn => turn.state), [TurnState.Complete]);
				assert.match(response(turns[0]), /resumed=false/);
				await send(provider, chat, 'second', 'second');
				assert.match(response((await provider.chats.getMessages(chat, context(chat)))[1]), /resumed=false/, 'the new session now exists and is resumed on the next process');
				await provider.shutdown();
			} finally {
				delete process.env.NATIVE_FIXTURE_STORE;
				await fs.rm(sessions, { recursive: true, force: true });
			}
		});

		test(`${dialect}: a chat with completed turns reports a lost native session instead of silently starting over`, async () => {
			const sessions = await fs.mkdtemp(join(tmpdir(), 'native-cli-sessions-'));
			process.env.NATIVE_FIXTURE_STORE = sessions;
			try {
				const provider = agent(dialect);
				const chat = URI.parse(`ahp-chat:/${dialect}-lost-session`);
				const done = { id: 'earlier', startedAt: new Date().toISOString(), message: { text: 'earlier', origin: { kind: MessageKind.User } }, responseParts: [], usage: undefined, state: TurnState.Complete };
				await database.setMetadata(`${dialect}.history.${chat.toString()}`, JSON.stringify([done]));
				await provider.materializeChat(chat, context(chat), JSON.stringify({ version: 1, provider: dialect, nativeId: 'sess_lost', cwd: tmpdir(), model: { id: 'fixture/one' }, persisted: true, createdAt: 1, modifiedAt: 1 }));
				await assert.rejects(send(provider, chat, 'again', 'again'), /Session not found/);
				await provider.shutdown();
			} finally {
				delete process.env.NATIVE_FIXTURE_STORE;
				await fs.rm(sessions, { recursive: true, force: true });
			}
		});
	}

	test('native CLIs inherit the user\'s environment without VS Code and Electron plumbing', async () => {
		const inherited = { PATH: '/usr/bin', HOME: '/home/user', DSH_TOKEN: 'keep', NODE_OPTIONS: '--require ./inspector.js', VSCODE_PID: '1', VSCODE_IPC_HOOK: '/tmp/hook', ELECTRON_RUN_AS_NODE: '1', ELECTRON_ENABLE_LOGGING: '1' };
		const none: INativeCliAgentConfig = { enabled: true, executable: '', args: [], home: '', models: [] };
		assert.deepStrictEqual((await nativeCliLaunch('dsh', none, tmpdir(), inherited)).env, { PATH: '/usr/bin', HOME: '/home/user', DSH_TOKEN: 'keep' });
		// Running this process's own binary as Node is deliberate and stays.
		assert.strictEqual((await nativeCliLaunch('dsh', { ...none, executable: process.execPath }, tmpdir(), inherited)).env.ELECTRON_RUN_AS_NODE, '1');
	});

	test('zcode on PATH leads to the installed application\'s bundled CLI, and only then', async function () {
		if (process.platform !== 'linux') { return this.skip(); }
		const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'native-cli-zcode-install-')));
		try {
			const application = join(root, 'opt/ZCode');
			await fs.mkdir(join(application, 'resources/glm'), { recursive: true });
			await fs.mkdir(join(application, 'resources/config/provider'), { recursive: true });
			await fs.mkdir(join(root, 'usr/bin'), { recursive: true });
			await fs.writeFile(join(application, 'zcode'), '#!/bin/sh\n', { mode: 0o755 });
			await fs.writeFile(join(application, 'resources/glm/zcode.cjs'), '');
			await fs.writeFile(join(application, 'resources/config/provider/zcode-builtin.json'), '{}');
			await fs.symlink(join(application, 'zcode'), join(root, 'usr/bin/zcode'));
			const none: INativeCliAgentConfig = { enabled: true, executable: '', args: [], home: root, models: [] };
			const path = { PATH: join(root, 'usr/bin') };

			const launch = await nativeCliLaunch('zcode', none, root, path);
			assert.deepStrictEqual({ executable: launch.executable, args: launch.args, asNode: launch.env.ELECTRON_RUN_AS_NODE, builtin: launch.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, personal: launch.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, installed: launch.installedProviderConfig }, {
				executable: join(application, 'zcode'),
				args: [join(application, 'resources/glm/zcode.cjs'), 'app-server', '--stdio'],
				asNode: '1',
				builtin: join(application, 'resources/config/provider/zcode-builtin.json'),
				personal: join(root, '.zcode/v2/provider_config.json'),
				installed: join(application, 'resources/config/provider/zcode-builtin.json'),
			});

			// An explicit executable is never replaced, and a launcher that is not an application is left alone.
			assert.strictEqual((await nativeCliLaunch('zcode', { ...none, executable: '/custom/zcode' }, root, path)).executable, '/custom/zcode');
			await fs.rm(join(application, 'resources/glm/zcode.cjs'));
			const plain = await nativeCliLaunch('zcode', none, root, path);
			assert.deepStrictEqual({ executable: plain.executable, args: plain.args, asNode: plain.env.ELECTRON_RUN_AS_NODE }, { executable: 'zcode', args: ['app-server', '--stdio'], asNode: undefined });
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('rejects malformed process arguments before spawning', () => {
		assert.throws(() => readNativeCliAgentConfigs({ [nativeCliAgentEnv]: JSON.stringify({ dsh: { enabled: true, args: 'unsafe shell string' } }) }), /Invalid dsh/);
	});

	test('a native process that cannot start fails its requests and shuts down at once', async () => {
		const transport = store.add(new NativeCliTransport({ executable: join(tmpdir(), 'no-such-native-binary'), args: [], env: process.env, cwd: tmpdir(), jsonrpc: true }));
		await assert.rejects(transport.request('anything'), /ENOENT/);
		const started = performance.now();
		await transport.shutdown();
		assert.ok(performance.now() - started < 1000, 'shutdown waited for a process that never started');
	});

	test('process exit rejects pending requests', async () => {
		const transport = store.add(new NativeCliTransport({ executable: process.execPath, args: ['-e', 'process.stdin.once("data",()=>process.exit(2))'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, cwd: tmpdir(), jsonrpc: true }));
		await assert.rejects(transport.request('pending'), /exited/);
		await transport.shutdown();
	});

	test('shutdown terminates a native process tree that ignores EOF', async function () {
		this.timeout(10_000);
		const script = `const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});setInterval(()=>{},1000);process.stdin.on('data',()=>process.stdout.write(JSON.stringify({id:1,result:child.pid})+'\\n'))`;
		const transport = store.add(new NativeCliTransport({ executable: process.execPath, args: ['-e', script], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, cwd: tmpdir(), jsonrpc: true }));
		const pid = await transport.request('child');
		assert.strictEqual(typeof pid, 'number');
		await transport.shutdown();
		let running = true;
		for (let attempt = 0; attempt < 20 && running; attempt++) {
			try { process.kill(Number(pid), 0); } catch { running = false; }
			if (running) { await new Promise(resolve => setTimeout(resolve, 25)); }
		}
		if (running) { process.kill(Number(pid), 'SIGKILL'); }
		assert.strictEqual(running, false, 'The native grandchild must not outlive shutdown');
	});
});
