/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { CustomizationType } from '../../common/state/sessionState.js';
import { discoverNativeCliCustomizations, nativeCliCustomizations } from '../../node/nativeCli/nativeCliCustomizations.js';

suite('Native CLI customizations', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('preserves native winners, canonical paths and invocation flags without scanning another harness', () => {
		const path = join(tmpdir(), 'shared-skill', 'SKILL.md');
		const result = nativeCliCustomizations('dsh', { complete: true, skills: [
			{ name: 'native-winner', path, description: 'Native description', invocation: { modelInvocable: false, userInvocable: false } },
			{ name: 'same-file', path },
			{ name: 'disabled', path: join(tmpdir(), 'disabled.md'), enabled: false },
		], instructions: [{ absolutePath: join(tmpdir(), 'AGENTS.md') }] });
		assert.deepStrictEqual(result.map(directory => ({
			writable: directory.type === CustomizationType.Directory && directory.writable,
			children: directory.children?.map(child => [child.name, child.uri, child.type === CustomizationType.Skill ? child.disableModelInvocation : undefined, child.type === CustomizationType.Skill ? child.disableUserInvocation : undefined]),
		})), [
			{ writable: false, children: [['native-winner', URI.file(path).toString(), true, true]] },
			{ writable: false, children: [['AGENTS.md', URI.file(join(tmpdir(), 'AGENTS.md')).toString(), undefined, undefined]] },
		]);
	});

	test('keeps pathless native skills read-only and rejects incomplete observations', () => {
		const result = nativeCliCustomizations('dsh', { skills: [{ name: 'runtime-only' }] });
		assert.deepStrictEqual(result.flatMap(directory => directory.children ?? []).map(child => [child.name, URI.parse(child.uri).scheme]), [['runtime-only', 'agent-builtin']]);
		assert.throws(() => nativeCliCustomizations('dsh', { skills: [], complete: false }), /incomplete/);
	});

	test('DSH queries native services without initializing a conversation, respects disabled instructions and removes its overlay', async () => {
		const root = await fs.mkdtemp(join(tmpdir(), 'native-customization-test-'));
		const audit = join(root, 'audit.json');
		const fixture = String.raw`
const fs=require('fs'),path=require('path'),url=require('url');
const patch=process.argv[process.argv.indexOf('--patch')+1];
const plugin=JSON.parse(fs.readFileSync(patch,'utf8').match(/name: (.+)/)[1]);
fs.writeFileSync(process.env.TEST_NATIVE_AUDIT,JSON.stringify({patch,plugin,cwd:process.cwd()}));
process.stdin.resume();
process.stdin.on('data',()=>{throw new Error('Discovery must not send a session request')});
import(url.pathToFileURL(plugin).href).then(module=>module.apply({
 get(name){if(name==='loader')return{await:async()=>{}};if(name==='skills')return{snapshot:async({cwd})=>({complete:true,skills:[{name:'native-skill',path:path.join(cwd,'native.md')}]})};},
 loader:{entries:()=>[
  {disabled:true,fiber:{},options:{name:'@deepseek-ai/dsh-agent-instructions'},moduleNamespace:{discoverBaselineInstructionFiles:()=>{throw new Error('Disabled plugin must not be read')}}},
  {disabled:false,fiber:{},options:{name:'@deepseek-ai/dsh-agent-instructions',config:{instructionFileCandidates:['CUSTOM.md']}},moduleNamespace:{discoverBaselineInstructionFiles:async options=>[{absolutePath:path.join(options.cwd,options.instructionFileCandidates[0])}]}}
 ]}
}));
`;
		try {
			const result = await discoverNativeCliCustomizations('dsh', { executable: process.execPath, args: ['-e', fixture, '--'], cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TEST_NATIVE_AUDIT: audit }, jsonrpc: true }, new AbortController().signal);
			const paths = JSON.parse(await fs.readFile(audit, 'utf8')) as { patch: string; plugin: string; cwd: string };
			assert.deepStrictEqual({ cwd: paths.cwd, items: result.flatMap(directory => directory.children ?? []).map(child => [child.type, child.name]) }, { cwd: await fs.realpath(root), items: [['skill', 'native-skill'], ['rule', 'CUSTOM.md']] });
			await assert.rejects(fs.stat(paths.patch), { code: 'ENOENT' });
			await assert.rejects(fs.stat(paths.plugin), { code: 'ENOENT' });
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test('ZCode uses workspace metadata instead of creating or resuming a session', async () => {
		const fixture = String.raw`
const readline=require('readline'),path=require('path');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='runtime/capabilities')return process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\n');
 if(m.method!=='skills/referenceCatalog')throw new Error('Unexpected session operation');
 process.stdout.write(JSON.stringify({id:m.id,result:{authority:'workspace',skills:[{name:'zcode-skill',path:path.join(m.params.workspace.workspacePath,'SKILL.md'),enabled:true}]}})+'\n');
});
`;
		const result = await discoverNativeCliCustomizations('zcode', { executable: process.execPath, args: ['-e', fixture], cwd: tmpdir(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, jsonrpc: false }, new AbortController().signal);
		assert.deepStrictEqual(result.flatMap(directory => directory.children ?? []).map(child => [child.name, child.uri]), [['zcode-skill', URI.file(join(tmpdir(), 'SKILL.md')).toString()]]);
	});

	test('aborted discovery never starts a native process', async () => {
		const abort = new AbortController();
		abort.abort();
		for (const id of ['dsh', 'zcode'] as const) {
			await assert.rejects(discoverNativeCliCustomizations(id, { executable: 'must-not-launch', args: [], cwd: tmpdir(), env: {}, jsonrpc: id === 'dsh' }, abort.signal), /Canceled/);
		}
	});
});
