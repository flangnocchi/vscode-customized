/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IDirectLanguageModelService } from '../../node/directLanguageModelService.js';

export function createTestDirectLanguageModelService(overrides: Partial<IDirectLanguageModelService> = {}): IDirectLanguageModelService {
	return {
		_serviceBrand: undefined,
		onDidChangeModels: () => Disposable.None,
		getModels: () => [],
		resolve: async () => { throw new Error('No direct language models configured'); },
		...overrides,
	};
}
