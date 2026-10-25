/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { TestConfigurationService } from '../../../configuration/test/common/testConfigurationService.js';
import { buildNativeCliAgentEnv, nativeCliAgentEnv } from '../../common/nativeCliAgentConfig.js';

suite('Native CLI agent configuration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('forwards exact argument boundaries and separate provider enablement', () => {
		const configuration = new TestConfigurationService({
			'chat.agentHost.dshAgent.enabled': true,
			'chat.agentHost.dshAgent.executable': '/Applications/An Agent/bin/dsh',
			'chat.agentHost.dshAgent.args': ['--profile', 'a profile', '$(literal)'],
			'chat.agentHost.dshAgent.home': '/a data folder',
		});
		const forwarded = JSON.parse(buildNativeCliAgentEnv(configuration, {})[nativeCliAgentEnv]);
		assert.deepStrictEqual(forwarded, {
			dsh: { enabled: true, executable: '/Applications/An Agent/bin/dsh', args: ['--profile', 'a profile', '$(literal)'], home: '/a data folder', models: [] },
			zcode: { enabled: false, executable: '', args: [], home: '', models: [] },
		});
	});

	test('preserves an explicit parent environment override', () => {
		assert.deepStrictEqual(buildNativeCliAgentEnv(new TestConfigurationService(), { [nativeCliAgentEnv]: '{"dsh":{"enabled":true}}' }), {});
	});
});
