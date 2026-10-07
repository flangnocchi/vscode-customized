/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { parseFrontMatter } from '../../../../base/common/yaml.js';
import { parseRuleFile, type IParsedPlugin } from '../../../agentPlugins/common/pluginParsers.js';
import { IFileService } from '../../../files/common/files.js';

/** Read shared always-on rules once when the native session is built. */
export async function sharedUserInstructionText(plugins: readonly IParsedPlugin[], fileService: IFileService): Promise<string> {
	const instructions: string[] = [];
	for (const instruction of plugins.flatMap(plugin => plugin.instructions)) {
		try {
			const rule = await parseRuleFile(instruction.uri, fileService);
			if (rule.globs?.length ? !rule.globs.some(glob => glob.trim() === '**' || glob.trim() === '**/*') : rule.alwaysApply === false) {
				continue;
			}
			const raw = (await fileService.readFile(instruction.uri)).value.toString();
			const body = (parseFrontMatter(raw)?.body ?? raw).trim();
			if (body) {
				instructions.push(body);
			}
		} catch { }
	}
	return instructions.join('\n\n');
}
