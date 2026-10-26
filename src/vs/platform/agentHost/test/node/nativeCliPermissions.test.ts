/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { nativeCliPermissionModeKey } from '../../common/nativeCliAgentConfig.js';
import { offersNoNativeCliPermissions, readNativeCliPermissions, resolveNativeCliPermissionConfig } from '../../node/nativeCli/nativeCliPermissions.js';

suite('Native CLI permissions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const catalog = { defaultMode: 'workspace-write', options: [{ id: 'read-only', name: 'read-only' }, { id: 'workspace-write', name: 'workspace-write' }] };
	const key = nativeCliPermissionModeKey('dsh');

	test('uses native defaults and exposes every native mode as a mutable chat choice', () => {
		const result = resolveNativeCliPermissionConfig('dsh', readNativeCliPermissions({ permissions: catalog }));
		const property = result.schema.properties[key];
		assert.deepStrictEqual({ values: result.values, modes: property.enum, chatMutable: property.chatMutable, sessionMutable: property.sessionMutable }, { values: { [key]: 'workspace-write' }, modes: ['read-only', 'workspace-write'], chatMutable: true, sessionMutable: true });
	});

	test('rejects unsupported selections and does not fabricate a catalog for an older SDK', () => {
		assert.throws(() => resolveNativeCliPermissionConfig('dsh', catalog, { [key]: 'danger-full-access' }), /does not offer/);
		assert.deepStrictEqual([readNativeCliPermissions({}), readNativeCliPermissions({ permissions: { ...catalog, defaultMode: 'missing' } })], [undefined, undefined]);
	});

	test('tells a runtime that has no permission modes from an answer that could not be read', () => {
		assert.deepStrictEqual([
			offersNoNativeCliPermissions({ complete: true }),
			offersNoNativeCliPermissions({ complete: true, permissions: { options: [], defaultMode: 'build' } }),
			offersNoNativeCliPermissions({ complete: false }),
			offersNoNativeCliPermissions({ permissions: { options: [{ id: 1 }], defaultMode: 'build' } }),
			offersNoNativeCliPermissions({ permissions: catalog }),
		], [true, true, false, false, false]);
	});

	test('keeps one harness choice from overriding another harness default', () => {
		const result = resolveNativeCliPermissionConfig('zcode', { defaultMode: 'build', options: [{ id: 'build', name: 'build' }] }, { [key]: 'read-only' });
		assert.deepStrictEqual(result.values, { [nativeCliPermissionModeKey('zcode')]: 'build' });
	});
});
