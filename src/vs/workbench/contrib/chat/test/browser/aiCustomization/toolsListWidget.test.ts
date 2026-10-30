/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { CustomizationToggle } from '../../../browser/aiCustomization/customizationToggle.js';
import { createRuntimeToolSets, isToolsTreeKeyboardTarget } from '../../../browser/aiCustomization/toolsListWidget.js';

suite('toolsListWidget', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('runtime sets retain confirmed VS Code and MCP tools and do not substitute Copilot tools', () => {
		const sets = createRuntimeToolSets({
			provider: 'test', label: 'Test', state: 'ready', scope: 'chat', tools: [
				{ name: 'NativeRead', loading: 'eager', source: 'builtin' },
				{ name: 'SharedRead', loading: 'eager', source: 'vscode' },
				{ name: 'RemoteSearch', loading: 'deferred', source: 'mcp' },
			]
		});
		assert.deepStrictEqual({ names: sets.flatMap(set => [...set.getTools()].map(tool => tool.displayName)), nativeIds: sets.every(set => set.id.startsWith('runtime:')), unknown: createRuntimeToolSets(undefined) }, { names: ['NativeRead', 'SharedRead', 'RemoteSearch'], nativeIds: true, unknown: [] });
	});

	test('handles tree keys only from the row itself', () => {
		const row = document.createElement('div');
		const moreButton = document.createElement('button');
		row.appendChild(moreButton);

		assert.deepStrictEqual({
			row: isToolsTreeKeyboardTarget(row, row),
			moreButton: isToolsTreeKeyboardTarget(moreButton, row),
		}, {
			row: true,
			moreButton: false,
		});
	});

	test('uses switches for customization enablement', () => {
		const enabledToggle = disposables.add(new CustomizationToggle({ ariaLabel: 'Enabled', checked: true }));
		const mixedToggle = disposables.add(new CustomizationToggle({ ariaLabel: 'Mixed', checked: 'mixed' }));

		assert.deepStrictEqual({
			enabledRole: enabledToggle.domNode.firstElementChild?.getAttribute('role'),
			enabledChecked: enabledToggle.domNode.firstElementChild?.getAttribute('aria-checked'),
			mixedRole: mixedToggle.domNode.firstElementChild?.getAttribute('role'),
			mixedChecked: mixedToggle.domNode.firstElementChild?.getAttribute('aria-checked'),
		}, {
			enabledRole: 'switch',
			enabledChecked: 'true',
			mixedRole: 'switch',
			mixedChecked: 'mixed',
		});
	});
});
