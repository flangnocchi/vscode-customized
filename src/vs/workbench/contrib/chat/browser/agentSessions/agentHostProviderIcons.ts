/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import type { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import './media/nativeCliAgentIcons.css';

const deepseekIcon = registerIcon('agent-host-dsh', Codicon.blank, localize('agentHost.dsh.icon', "DeepSeek Harness agent icon."));
const zcodeIcon = registerIcon('agent-host-zcode', Codicon.blank, localize('agentHost.zcode.icon', "ZCode agent icon."));

/** The same native brand marks are used in the workbench and Agents Window. */
export function getNativeCliAgentIcon(provider: string): ThemeIcon | undefined {
	if (provider === 'dsh' || provider === 'agent-host-dsh') { return deepseekIcon; }
	if (provider === 'zcode' || provider === 'agent-host-zcode') { return zcodeIcon; }
	return undefined;
}
