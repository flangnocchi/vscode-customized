/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { FileService } from '../../../files/common/fileService.js';
import { IFileService } from '../../../files/common/files.js';
import { DiskFileSystemProvider } from '../../../files/node/diskFileSystemProvider.js';
import { IInstantiationService } from '../../../instantiation/common/instantiation.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../instantiation/common/serviceCollection.js';
import { ILogService, NullLogService } from '../../../log/common/log.js';
import { IDiffComputeService } from '../../common/diffComputeService.js';
import { IAgentEditAttributionService, NullAgentEditAttributionService } from '../../common/fileEditAttribution.js';
import { ISessionDataService } from '../../common/sessionDataService.js';
import { AgentHostFileEditCoordinator, IAgentHostFileEditCoordinator } from '../../node/agentHostFileEditCoordinator.js';
import { IEditArcReporterService, NullEditArcReporterService } from '../../node/shared/editArcReporter.js';
import { IEditSurvivalReporterFactory, NullEditSurvivalReporterFactory } from '../../node/shared/editSurvivalReporter.js';
import { TestDiffComputeService } from '../common/sessionTestHelpers.js';

/** The services a native agent needs to record the files that its tools edit, backed by the real file system. */
export function createNativeCliInstantiationService(store: DisposableStore, data: ISessionDataService): IInstantiationService {
	const log = new NullLogService();
	const fileService = store.add(new FileService(log));
	store.add(fileService.registerProvider(Schemas.file, store.add(new DiskFileSystemProvider(log))));
	return store.add(new InstantiationService(new ServiceCollection(
		[ILogService, log],
		[IFileService, fileService],
		[IAgentHostFileEditCoordinator, store.add(new AgentHostFileEditCoordinator())],
		[ISessionDataService, data],
		[IDiffComputeService, new TestDiffComputeService()],
		[IAgentEditAttributionService, new NullAgentEditAttributionService()],
		[IEditSurvivalReporterFactory, new NullEditSurvivalReporterFactory()],
		[IEditArcReporterService, new NullEditArcReporterService()],
	)));
}
