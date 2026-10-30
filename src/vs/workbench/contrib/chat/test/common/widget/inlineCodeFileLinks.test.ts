/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { inlineCodeFileLink, linkifyInlineCodeFilePaths } from '../../../common/widget/inlineCodeFileLinks.js';

suite('Inline code file links', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('links an absolute file path, with its line and column', () => {
		assert.deepStrictEqual(
			['/home/me/app/main.ts', '/home/me/app/main.ts:12', '/home/me/app/main.ts:12:5', '/home/me/随便.txt', '/home/me/my-app/a_b.test.ts'].map(inlineCodeFileLink),
			[
				'[](file:///home/me/app/main.ts)',
				'[](file:///home/me/app/main.ts#L12)',
				'[](file:///home/me/app/main.ts#L12%2C5)',
				`[](file:///home/me/${encodeURIComponent('随便')}.txt)`,
				'[](file:///home/me/my-app/a_b.test.ts)',
			]);
	});

	test('links a Windows drive path', () => {
		assert.deepStrictEqual(
			['C:\\Users\\me\\a.txt', 'C:/Users/me/a.txt'].map(inlineCodeFileLink),
			['[](file:///c%3A/Users/me/a.txt)', '[](file:///c%3A/Users/me/a.txt)']);
	});

	test('leaves everything that is not clearly a file path alone', () => {
		assert.deepStrictEqual(
			['/api/users', '/etc/hosts', 'src/main.ts', './main.ts', '../a/main.ts', '/home/../main.ts', '/home/me/ main.ts', '/home/me/*.ts', '/api/v1.2', 'https://example.com/a.html', '//host/share/a.txt', 'npm run build', '/home/me/a.txt && rm', ''].map(inlineCodeFileLink),
			new Array(14).fill(undefined));
	});

	test('rewrites inline code only, and leaves links and code blocks as written', () => {
		assert.strictEqual(
			linkifyInlineCodeFilePaths('已创建 `/tmp/a.txt`，见 [`/tmp/b.txt`](file:///tmp/b.txt)。\n\n```\n`/tmp/c.txt`\n```\n\n`npm test`'),
			'已创建 [](file:///tmp/a.txt)，见 [`/tmp/b.txt`](file:///tmp/b.txt)。\n\n```\n`/tmp/c.txt`\n```\n\n`npm test`');
	});

	test('returns text without backticks as is', () => {
		const text = 'No code here: /tmp/a.txt';
		assert.strictEqual(linkifyInlineCodeFilePaths(text), text);
	});
});
