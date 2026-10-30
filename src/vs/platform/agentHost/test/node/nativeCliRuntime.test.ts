/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { pathToFileURL } from 'url';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { canObserveNativeCliRuntime, dshRuntimeObserver, observeNativeCliRuntime } from '../../node/nativeCli/nativeCliRuntime.js';
import { NativeCliTransport, record } from '../../node/nativeCli/nativeCliTransport.js';

suite('Native CLI runtime observation', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('only the DSH profile server and the ZCode CommonJS entry are extended', () => {
		const observable = (...args: string[]) => canObserveNativeCliRuntime({ executable: 'native', args, env: {}, cwd: '/', jsonrpc: false });
		assert.deepStrictEqual({
			dsh: observable('--profile', 'sdk'),
			dshEquals: observable('--profile=sdk'),
			zcode: observable('/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs', 'app-server', '--stdio'),
			zcodeWindows: observable('C:\\ZCode\\zcode.cjs', 'app-server'),
			zcodeOnPath: observable('app-server', '--stdio'),
			otherScript: observable('/opt/notzcode.cjs'),
			otherFlag: observable('--profiles'),
		}, { dsh: true, dshEquals: true, zcode: true, zcodeWindows: true, zcodeOnPath: false, otherScript: false, otherFlag: false });
	});

	// The same fake ZCode, with the dispatcher written the way two different builds of it are.
	const dispatchers = {
		older: { method: 'dispatch', code: String.raw`async dispatch(request){switch(request.method){case Methods.runtimeCapabilities:{let result=Schema.parse(request.params??{});return result;}default:throw Error('Unexpected operation');}}` },
		current: { method: 'dispatchRequest', code: String.raw`async dispatchRequest(t){switch(t.method){case Methods.runtimeCapabilities:return{independentPlanState:!0,historyFirst:!0};default:throw Error('Unexpected operation');}}` },
	} as const;

	for (const [shape, dispatcher] of Object.entries(dispatchers)) {
		test(`ZCode reads the selected model contract and native sources without invoking tools or changing installed code (${shape} dispatcher)`, async () => {
			const root = await fs.mkdtemp(join(tmpdir(), 'native-runtime-test-'));
			const target = join(root, 'zcode.cjs');
			const source = String.raw`
const readline=require('readline');const Methods={runtimeCapabilities:'runtime/capabilities'};const Schema={parse:v=>v,object:v=>v};const Id={};const Modes={options:['plan','build']};const ModeRequest=Schema.object({sessionId:Id,mode:Modes,expectedRevision:Id});
let mode='build';const runtime={getMode:()=>mode,setExecutionState:async state=>{mode=state.mode},config:{modelSelection:{modelId:'default'}},registeredMcpToolNames:['mcp_search'],
	getSessionModelSelection:()=>undefined,modelFactory:({selection})=>selection,
	getTools:model=>[{name:model.modelId,description:'Selected model tool'},{name:'mcp_search',deferLoading:true}],
	getAgentDefinitions:()=>({activeAgents:[{name:'Explore'}]}),contextSourceSnapshot:{userInstructions:{sources:[{filePath:'/workspace/AGENTS.md',content:'must not cross the boundary'}]}},
};
class Server{context={sessions:new Map([['chat',{app:{runtime,getSkillCatalog:async()=>({skills:[]})}}]])};${dispatcher.code}}
const server=new Server();readline.createInterface({input:process.stdin}).on('line',async line=>{const m=JSON.parse(line);try{process.stdout.write(JSON.stringify({id:m.id,result:await server.${dispatcher.method}(m)})+'\n')}catch{process.stdout.write(JSON.stringify({id:m.id,error:{message:'Unsupported'}})+'\n')}});
`;
			let transport: NativeCliTransport | undefined;
			try {
				await fs.writeFile(target, source);
				const observer = disposables.add(await observeNativeCliRuntime('zcode', { executable: process.execPath, args: [target], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, cwd: root, jsonrpc: false }));
				transport = disposables.add(new NativeCliTransport(observer.launch));
				const applied = await transport.request('vscode/setPermissionMode', { sessionId: 'chat', mode: 'plan' });
				assert.deepStrictEqual(applied, { mode: 'plan' });
				await assert.rejects(transport.request('vscode/setPermissionMode', { sessionId: 'chat', mode: 'invented' }), /Unsupported/);
				const result = record(await transport.request('vscode/runtimeInventory', { sessionId: 'chat', modelSelection: { modelId: 'chosen' } }));
				assert.deepStrictEqual({ tools: result.tools, agents: result.agents, instructions: result.instructions, sourceUnchanged: await fs.readFile(target, 'utf8') === source }, {
					tools: [{ name: 'chosen', description: 'Selected model tool', loading: 'eager', source: 'builtin' }, { name: 'mcp_search', loading: 'deferred', source: 'mcp' }], agents: [{ name: 'Explore' }], instructions: [{ absolutePath: '/workspace/AGENTS.md' }], sourceUnchanged: true,
				});
			} finally {
				await transport?.shutdown();
				await fs.rm(root, { recursive: true, force: true });
			}
		});
	}

	test('the DSH observer relays an approval without replacing the tool input, and leaves an SDK it does not recognise working', async () => {
		const root = await fs.mkdtemp(join(tmpdir(), 'native-runtime-dsh-'));
		try {
			const file = join(root, 'observer.mjs');
			await fs.writeFile(file, dshRuntimeObserver);
			const observer = await import(pathToFileURL(file).href);
			const handlers = new Map<string, (request: Record<string, unknown>) => Promise<string>>();
			const requests: { method: string; params: unknown }[] = [];
			class Server {
				disposers: unknown[] | undefined = [];
				sessions = new Map([['native-session', {}]]);
				transport = { request: async (method: string, params: unknown) => { requests.push({ method, params }); return { outcome: 'allowed-once' }; }, notify() { } };
				async handleRequest(method: string) { return `original:${method}`; }
			}
			const loader = { await: async () => { }, entries: () => [{ options: { name: '@deepseek-ai/dsh-sdk-jsonrpc-server' }, moduleNamespace: { HarnessSdkJsonRpcServer: Server } }] };
			observer.apply({ get: (name: string) => name === 'loader' ? loader : undefined, loader, effect() { }, on: (event: string, handler: (request: Record<string, unknown>) => Promise<string>) => { handlers.set(event, handler); return () => { }; } });
			await new Promise(resolve => setTimeout(resolve, 20));

			const recognised = new Server();
			assert.strictEqual(await recognised.handleRequest('initialize'), 'original:initialize');
			const outcome = await handlers.get('approval/request')!({ callId: 'call-1', toolName: 'write', reason: 'Write a file', displayReason: { en: 'Write /workspace/a.txt', zh: '写入 /workspace/a.txt' } });
			assert.deepStrictEqual({ outcome, requests }, {
				outcome: 'allowed-once',
				// Only what the SDK knows about the request. The tool call's own input is already on the client.
				requests: [{ method: 'approval/request', params: { sessionId: 'native-session', toolCallId: 'call-1', toolName: 'write', reason: 'Write /workspace/a.txt' } }],
			});

			const unrecognised = new Server();
			unrecognised.disposers = undefined;
			assert.strictEqual(await unrecognised.handleRequest('initialize'), 'original:initialize');
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('an unsupported ZCode dispatcher still runs normally', async () => {
		const root = await fs.mkdtemp(join(tmpdir(), 'native-runtime-unsupported-'));
		let transport: NativeCliTransport | undefined;
		try {
			const target = join(root, 'zcode.cjs');
			await fs.writeFile(target, `require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);process.stdout.write(JSON.stringify({id:m.id,result:{normal:true}})+'\\n')})`);
			const observer = disposables.add(await observeNativeCliRuntime('zcode', { executable: process.execPath, args: [target], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, cwd: root, jsonrpc: false }));
			transport = disposables.add(new NativeCliTransport(observer.launch));
			assert.deepStrictEqual(await transport.request('runtime/capabilities'), { normal: true });
		} finally {
			await transport?.shutdown();
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
