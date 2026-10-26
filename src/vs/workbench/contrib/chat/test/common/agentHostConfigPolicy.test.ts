/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isNativeCliFullAccessPolicyRestricted } from '../../common/agentHostConfigPolicy.js';

suite('Agent host config policy', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('withholds the native modes that approve everything only while policy disables auto-approval', () => {
		assert.deepStrictEqual({
			underPolicy: [
				isNativeCliFullAccessPolicyRestricted('dsh.permissionMode', 'danger-full-access', true),
				isNativeCliFullAccessPolicyRestricted('zcode.permissionMode', 'yolo', true),
			],
			otherModes: [
				isNativeCliFullAccessPolicyRestricted('dsh.permissionMode', 'workspace-write', true),
				isNativeCliFullAccessPolicyRestricted('zcode.permissionMode', 'build', true),
				isNativeCliFullAccessPolicyRestricted('dsh.permissionMode', 'yolo', true),
			],
			withoutPolicy: isNativeCliFullAccessPolicyRestricted('dsh.permissionMode', 'danger-full-access', false),
			otherProperty: isNativeCliFullAccessPolicyRestricted('autoApprove', 'yolo', true),
		}, {
			underPolicy: [true, true],
			otherModes: [false, false, false],
			withoutPolicy: false,
			otherProperty: false,
		});
	});
});
