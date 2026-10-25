/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { observeNativeCliRuntime } from '../../node/nativeCli/nativeCliRuntime.js';
import { NativeCliTransport, record } from '../../node/nativeCli/nativeCliTransport.js';

suite('Native CLI runtime observation', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('ZCode reads the selected model contract and native sources without invoking tools or changing installed code', async () => {
		const root = await fs.mkdtemp(join(tmpdir(), 'native-runtime-test-'));
		const target = join(root, 'zcode.cjs');
		const source = String.raw`
const readline=require('readline');const Methods={runtimeCapabilities:'runtime/capabilities'};const Schema={parse:v=>v,object:v=>v};const Id={};const Modes={options:['plan','build']};const ModeRequest=Schema.object({sessionId:Id,mode:Modes,expectedRevision:Id});
let mode='build';const runtime={getMode:()=>mode,setExecutionState:async state=>{mode=state.mode},config:{modelSelection:{modelId:'default'}},registeredMcpToolNames:['mcp_search'],
 getSessionModelSelection:()=>undefined,modelFactory:({selection})=>selection,
 getTools:model=>[{name:model.modelId,description:'Selected model tool'},{name:'mcp_search',deferLoading:true}],
 getAgentDefinitions:()=>({activeAgents:[{name:'Explore'}]}),contextSourceSnapshot:{userInstructions:{sources:[{filePath:'/workspace/AGENTS.md',content:'must not cross the boundary'}]}},
};
class Server{context={sessions:new Map([['chat',{app:{runtime,getSkillCatalog:async()=>({skills:[]})}}]])};async dispatch(request){switch(request.method){case Methods.runtimeCapabilities:{let result=Schema.parse(request.params??{});return result;}default:throw Error('Unexpected operation');}}}
const server=new Server();readline.createInterface({input:process.stdin}).on('line',async line=>{const m=JSON.parse(line);try{process.stdout.write(JSON.stringify({id:m.id,result:await server.dispatch(m)})+'\n')}catch{process.stdout.write(JSON.stringify({id:m.id,error:{message:'Unsupported'}})+'\n')}});
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
