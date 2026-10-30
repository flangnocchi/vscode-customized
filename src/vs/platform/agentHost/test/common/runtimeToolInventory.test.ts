/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { isRuntimeManagedCustomization, readRuntimePlugins, readRuntimeToolInventory, withRuntimeManagedCustomization, withRuntimePlugins, withRuntimeToolInventory, type IRuntimeToolInventory } from '../../common/meta/runtimeToolInventory.js';

suite('Runtime tool inventory metadata', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const inventory: IRuntimeToolInventory = {
		provider: 'test', label: 'Test', state: 'ready', scope: 'chat', tools: [
			{ name: 'Read', loading: 'eager', source: 'builtin' },
			{ name: 'extension/tool', description: 'Shared tool', loading: 'deferred', source: 'vscode' },
			{ name: 'mcp_tool', loading: 'binding', source: 'mcp', sourceName: 'Server' },
		]
	};

	test('retains all runtime-confirmed origins and distinguishes unknown from an empty registry', () => {
		assert.deepStrictEqual([
			readRuntimeToolInventory([]),
			readRuntimeToolInventory([{ _meta: withRuntimeToolInventory({ unrelated: true }, inventory) }]),
			readRuntimeToolInventory([{ _meta: withRuntimeToolInventory(undefined, { ...inventory, tools: [] }) }]),
		], [undefined, inventory, { ...inventory, tools: [] }]);
	});

	test('rejects malformed inventory rather than asserting tool availability', () => {
		const values = [null, [], {}, { ...inventory, scope: 'unknown' }, { ...inventory, tools: [{ name: 1 }] }, { ...inventory, tools: [{ name: 'tool', loading: 'unknown', source: 'builtin' }] }, { ...inventory, tools: [{ name: 'tool', loading: 'eager', source: 'unknown' }] }];
		assert.deepStrictEqual(values.map(value => readRuntimeToolInventory([{ _meta: { 'vscode.runtimeToolInventory': value } }])), values.map(() => undefined));
	});

	test('preserves native disabled plugins and limits lifecycle control to explicit runtime ownership', () => {
		const plugins = [{ id: 'native:p', name: 'Plugin', enabled: false, status: 'disabled' as const }];
		assert.deepStrictEqual({
			plugins: readRuntimePlugins([{ _meta: withRuntimePlugins(undefined, plugins) }]),
			managed: [withRuntimeManagedCustomization(undefined), { 'vscode.runtimeManagedCustomization': 'true' }, undefined].map(_meta => isRuntimeManagedCustomization({ _meta })),
		}, { plugins, managed: [true, false, false] });
	});
});
