/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { tmpdir } from 'os';
import { DeferredPromise } from '../../../../base/common/async.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { type IAgentChatContext, fixedChatOwnerRef } from '../../common/agent.js';
import { nativeCliAgentEnv, type INativeCliAgentConfig, type NativeCliAgentId } from '../../common/nativeCliAgentConfig.js';
import { ActionType } from '../../common/state/sessionActions.js';
import { ResponsePartKind, TurnState, type Turn } from '../../common/state/sessionState.js';
import { NativeCliAgent, readNativeCliAgentConfigs } from '../../node/nativeCli/nativeCliAgent.js';
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
  session=p.sessionId;restored=m.method==='session/resume';if(!m.jsonrpc){creation=m.id;send({id:'preferences',method:'session/requestRuntimePreferences',params:{sessionId:session,scope:'runtime-materialization'}});break;}send({id:m.id,result:{settings:{model:{available:[{ref:{providerId:'fixture',modelId:'one'},label:'Fixture Model'}]}}}});break;
 case 'session/subscribe':send({id:m.id,result:{}});break;
 case 'session/prompt':case 'session/send': {
	  done=false;waiter=undefined;const dialect=m.method==='session/prompt'?'dsh':'zcode';
	  if(dialect==='dsh'&&!Array.isArray(p.contentBlocks)){send({id:m.id,error:{message:'contentBlocks required'}});break;}
	  const prompt=dialect==='dsh'?p.contentBlocks.map(b=>b.text||'').join(''):p.content;
  send({id:m.id,result:dialect==='dsh'?{messageId:'message'}:{accepted:true}});
	  if(prompt==='crash'){process.exit(2);break;}
	  if(prompt==='hold'){if(dialect==='dsh')dsh('assistant/message',{message:{content:[{type:'text',text:'waiting'}]}});else event('part.delta',{partId:'answer',field:'text',delta:'waiting'});break;}
	  if(prompt==='permission'){send({id:'permission',method:'approval/request',params:{sessionId:session,callId:'call-1',toolName:'write'}});break;}
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
	const config: INativeCliAgentConfig = { enabled: true, executable: process.execPath, args: ['-e', fixture], home: '', models: [] };

	teardown(() => store.clear());
	suiteTeardown(() => { database.dispose(); store.dispose(); });
	ensureNoDisposablesAreLeakedInTestSuite();

	function agent(id: NativeCliAgentId): NativeCliAgent {
		return store.add(new NativeCliAgent(id, config, data, new NullLogService()));
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
		store.add(provider.onDidChatProgress(signal => {
			if (signal.kind === 'action' && signal.action.type === ActionType.ChatToolCallReady && !signal.action.confirmed) { provider.respondToPermissionRequest(signal.action.toolCallId, false); }
		}));
		await send(provider, chat, 'permission', 'permission-turn');
		const turns = await provider.chats.getMessages(chat, context(chat));
		assert.match(response(turns[0]), /rejected/);
		await provider.shutdown();
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

	test('preserves a UTF-8 code point split across protocol chunks', async () => {
		const script = `process.stdin.once('data',()=>{const b=Buffer.from(JSON.stringify({id:1,result:'你好🌱'})+'\\n');const p=b.indexOf(Buffer.from('🌱'))+1;process.stdout.write(b.subarray(0,p));setTimeout(()=>process.stdout.write(b.subarray(p)),5)})`;
		const transport = store.add(new NativeCliTransport({ executable: process.execPath, args: ['-e', script], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, cwd: tmpdir(), jsonrpc: true }));
		assert.strictEqual(await transport.request('unicode'), '你好🌱');
		await transport.shutdown();
	});

	test('rejects malformed process arguments before spawning', () => {
		assert.throws(() => readNativeCliAgentConfigs({ [nativeCliAgentEnv]: JSON.stringify({ dsh: { enabled: true, args: 'unsafe shell string' } }) }), /Invalid dsh/);
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
