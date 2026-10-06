/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { upcastPartial } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { codexSharedMcpServerName, codexUnifiedUserCustomizationOverrides } from '../../../node/codex/codexUnifiedUserCustomizations.js';
import type { Config } from '../../../node/codex/protocol/generated/v2/Config.js';
import type { SkillMetadata } from '../../../node/codex/protocol/generated/v2/SkillMetadata.js';

suite('codexUnifiedUserCustomizations', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('disables native personal skills while retaining private MCP, workspace and system skill decisions', () => {
		const config = upcastPartial<Config>({ mcp_servers: { personal: { command: 'native' }, shared: { command: 'old' } }, skills: { config: [{ path: '/home/personal/SKILL.md', enabled: true }, { path: '/repo/SKILL.md', enabled: false }] } });
		const skills = ['user', 'repo', 'system'].map((scope, index) => upcastPartial<SkillMetadata>({ scope: scope as SkillMetadata['scope'], path: ['/home/personal/SKILL.md', '/repo/SKILL.md', '/system/SKILL.md'][index] }));
		const overrides = codexUnifiedUserCustomizationOverrides(config, { data: [{ cwd: '/repo', skills, errors: [] }] }, { shared: { command: 'client', args: ['test'] } });
		assert.deepStrictEqual(overrides, {
			overrides: {
				mcp_servers: { shared: { enabled: false }, [codexSharedMcpServerName('shared')]: { command: 'client', args: ['test'], enabled: true } },
				skills: { config: [{ path: '/repo/SKILL.md', enabled: false }, { path: '/home/personal/SKILL.md', enabled: false }] },
			},
			mcpServerAliases: new Map([['shared', codexSharedMcpServerName('shared')]]),
		});
	});

	test('an empty client catalog leaves private MCP configuration unchanged', () => {
		const config = upcastPartial<Config>({ mcp_servers: { personal: { url: 'https://example.com/mcp' } } });
		const before = JSON.stringify(config);
		const result = codexUnifiedUserCustomizationOverrides(config, { data: [] }, {});
		assert.deepStrictEqual({ result: result.overrides, aliases: result.mcpServerAliases.size, unchanged: JSON.stringify(config) === before }, { result: { mcp_servers: {}, skills: { config: [] } }, aliases: 0, unchanged: true });
	});

	test('disabled shared servers reserve their names without disabling unrelated private servers', () => {
		const config = upcastPartial<Config>({ mcp_servers: { personal: { command: 'native' }, shared: { command: 'shadow' } } });
		const result = codexUnifiedUserCustomizationOverrides(config, { data: [] }, {}, { shared: { command: 'client', args: ['shared'] } });
		assert.deepStrictEqual(result.overrides.mcp_servers, { shared: { enabled: false }, [codexSharedMcpServerName('shared')]: { command: 'client', args: ['shared'], enabled: false } });
	});

	test('HTTP shared servers cannot inherit native stdio fields or overwrite a private alias name', () => {
		const privateAlias = codexSharedMcpServerName('shared');
		const config = upcastPartial<Config>({ mcp_servers: { shared: { command: 'native', args: ['wrong'] }, [privateAlias]: { command: 'private' } } });
		const result = codexUnifiedUserCustomizationOverrides(config, { data: [] }, { shared: { url: 'https://example.com/mcp' } });
		assert.deepStrictEqual({ alias: result.mcpServerAliases.get('shared'), servers: result.overrides.mcp_servers }, {
			alias: `${privateAlias}_1`, servers: { shared: { enabled: false }, [`${privateAlias}_1`]: { url: 'https://example.com/mcp', enabled: true } },
		});
	});
});
