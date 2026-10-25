/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { discoverNativeCliModels, dshModelCatalog, zcodeModelCatalog } from '../../node/nativeCli/nativeCliModelCatalog.js';

suite('Native CLI model catalogs', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('DSH uses configured names, routes, thinking options and the native default', () => {
		const catalog = dshModelCatalog(`
- name: '@deepseek-ai/dsh-agent-default-model'
  config: { provider: router, model: group/flash, reasoningEffort: max }
- name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      router:
        apiKey: do-not-expose
        models:
          - { id: group/pro, name: Pro, contextWindow: 1000000 }
          - id: group/flash
            name: My Flash
            contextWindow: 1048576
            reasoningEfforts: { low: low, high: high, max: max }
- name: '@deepseek-ai/dsh-llm-pi-ai'
  disabled: true
  config:
    providers:
      disabled:
        models: [{ id: hidden }]
`);
		assert.deepStrictEqual({
			defaultModel: catalog.defaultModel,
			models: catalog.models.map(model => [model.id, model.name, model.configSchema?.properties.reasoningEffort.enum, model.configSchema?.properties.reasoningEffort.default]),
			containsSecret: JSON.stringify(catalog).includes('do-not-expose'),
		}, {
			defaultModel: { id: 'router/group/flash', config: { reasoningEffort: 'max' } },
			models: [['router/group/flash', 'My Flash', ['low', 'high', 'max'], 'max'], ['router/group/pro', 'Pro', undefined, undefined]],
			containsSecret: false,
		});
	});

	test('DSH never evaluates native YAML code tags', () => {
		const catalog = dshModelCatalog(`
- name: '@deepseek-ai/dsh-agent-default-model'
  config: { provider: router, model: flash }
- name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      router:
        apiKey: !!js "throw new Error('must not execute')"
        models: [{ id: flash, name: Flash }]
`);
		assert.deepStrictEqual(catalog.models.map(model => [model.id, model.name]), [['router/flash', 'Flash']]);
	});

	test('DSH built-in names come from SDK metadata instead of a Default placeholder', () => {
		const catalog = dshModelCatalog(`
- name: '@deepseek-ai/dsh-agent-default-model'
  config: { provider: deepseek-account, model: flash }
`, [{ id: 'flash', name: 'Native Flash' }, { id: 'pro', name: 'Native Pro' }]);
		assert.deepStrictEqual(catalog.models.map(model => [model.id, model.name]), [['deepseek-account/flash', 'Native Flash'], ['deepseek-account/pro', 'Native Pro']]);
	});

	test('ZCode uses resolved native reasoning and hides unusable account routes', () => {
		const catalog = zcodeModelCatalog({ settings: { model: { available: [
			{ ref: { providerId: 'account:subscription', modelId: 'unusable' }, label: 'Subscription' },
			{ ref: { providerId: 'router', modelId: 'group/flash' }, label: 'Flash', reasoning: { levels: [{ value: 'low', label: 'Low' }, { value: 'max', label: 'Max' }], defaultLevel: 'max' } },
			{ ref: { providerId: 'router', modelId: 'disabled' }, disabledReason: 'disabled' },
		] } } });
		assert.deepStrictEqual({ defaultModel: catalog.defaultModel, models: catalog.models.map(model => [model.id, model.name, model.configSchema?.properties.reasoningEffort.default]) }, { defaultModel: { id: 'router/group/flash' }, models: [['router/group/flash', 'Flash', 'max']] });
	});

	test('ZCode discovery runs in an isolated home and never edits the original provider configuration', async () => {
		const root = await fs.mkdtemp(join(tmpdir(), 'native-catalog-test-'));
		const source = join(root, 'provider_config.json');
		const original = '{"private":"test-secret"}';
		await fs.writeFile(source, original);
		const fixture = String.raw`
const fs=require('fs'),path=require('path'),readline=require('readline');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='session/create'){
  fs.writeFileSync(process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE,'modified');
  process.stdout.write(JSON.stringify({id:m.id,result:{settings:{model:{available:[{ref:{providerId:'fixture',modelId:'one'},label:process.env.ZCODE_DATA_BASE_DIR}]}}}})+'\n');
 }else process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\n');
});
`;
		try {
			const catalog = await discoverNativeCliModels('zcode', { executable: process.execPath, args: ['-e', fixture], cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: source }, jsonrpc: false }, new AbortController().signal);
			assert.strictEqual(await fs.readFile(source, 'utf8'), original);
			assert.strictEqual(catalog.models[0].id, 'fixture/one');
			const probeHome = catalog.models[0].name;
			assert.notStrictEqual(probeHome, root);
			await assert.rejects(fs.stat(probeHome), { code: 'ENOENT' });
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
