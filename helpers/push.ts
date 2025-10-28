import ObsidianGoogleDrive from "main";
import { Modal, Notice, setIcon, Setting, TFile, TFolder } from "obsidian";
import {
	batchAsyncs,
	fileNameFromPath,
	folderMimeType,
	foldersToBatches,
	getSyncMessage,
} from "./drive";
import { pull } from "./pull";
import { ErrorManager, SyncProgress } from "./errorManager";

class ConfirmPushModal extends Modal {
	proceed: (res: boolean) => void;

	constructor(
		t: ObsidianGoogleDrive,
		initialOperations: [string, "create" | "delete" | "modify"][],
		proceed: (res: boolean) => void
	) {
		super(t.app);
		this.proceed = proceed;

		this.setTitle("Push confirmation");
		this.contentEl
			.createEl("p")
			.setText(
				"Do you want to push the following changes to Google Drive:"
			);
		const container = this.contentEl.createEl("div");

		const render = (operations: typeof initialOperations) => {
			container.empty();
			operations.map(([path, op]) => {
				const div = container.createDiv();
				div.addClass("operation-container");

				const p = div.createEl("p");
				p.createEl("b").setText(`${op[0].toUpperCase()}${op.slice(1)}`);
				p.createSpan().setText(`: ${path}`);

				if (
					op === "delete" &&
					operations.some(([file]) => path.startsWith(file + "/"))
				) {
					return;
				}

				const btn = div.createDiv().createEl("button");
				setIcon(btn, "trash-2");
				btn.onclick = async () => {
					const nestedFiles = operations
						.map(([file]) => file)
						.filter(
							(file) =>
								file.startsWith(path + "/") || file === path
						);
					const proceed = await new Promise<boolean>((resolve) => {
						new ConfirmUndoModal(
							t,
							op,
							nestedFiles,
							resolve
						).open();
					});

					if (!proceed) return;

					nestedFiles.forEach(
						(file) => delete t.settings.operations[file]
					);
					const newOperations = operations.filter(
						([file]) => !nestedFiles.includes(file)
					);
					if (!newOperations.length) return this.close();
					render(newOperations);
				};
			});
		};

		render(initialOperations);

		new Setting(this.contentEl)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => this.close())
			)
			.addButton((btn) =>
				btn
					.setButtonText("Confirm")
					.setCta()
					.onClick(() => {
						proceed(true);
						this.close();
					})
			);
	}

	onClose() {
		this.proceed(false);
	}
}

class ConfirmUndoModal extends Modal {
	proceed: (res: boolean) => void;
	t: ObsidianGoogleDrive;
	filePathToId: Record<string, string>;

	constructor(
		t: ObsidianGoogleDrive,
		operation: "create" | "delete" | "modify",
		files: string[],
		proceed: (res: boolean) => void
	) {
		super(t.app);
		this.t = t;
		this.filePathToId = Object.fromEntries(
			Object.entries(this.t.settings.driveIdToPath).map(([id, path]) => [
				path,
				id,
			])
		);

		const operationMap = {
			create: "creating",
			delete: "deleting",
			modify: "modifying",
		};

		this.setTitle("Undo confirmation");
		this.contentEl
			.createEl("p")
			.setText(
				`Are you sure you want to undo ${operationMap[operation]} the following file(s):`
			);
		this.contentEl.createEl("ul").append(
			...files.map((file) => {
				const li = this.contentEl.createEl("li");
				li.addClass("operation-file");
				li.setText(file);
				return li;
			})
		);
		this.proceed = proceed;
		new Setting(this.contentEl)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => this.close())
			)
			.addButton((btn) =>
				btn
					.setButtonText("Confirm")
					.setCta()
					.onClick(async () => {
						btn.setDisabled(true);
						if (operation === "delete") {
							await this.handleDelete(files);
						}
						if (operation === "create") {
							await this.handleCreate(files[0]);
						}
						if (operation === "modify") {
							await this.handleModify(files[0]);
						}
						proceed(true);
						this.close();
					})
			);
	}

	onClose() {
		this.proceed(false);
	}

	async handleDelete(paths: string[]) {
		const files = await this.t.drive.searchFiles({
			include: ["id", "mimeType", "properties", "modifiedTime"],
			matches: paths.map((path) => ({ properties: { path } })),
		});
		if (!files) {
			return new Notice("An error occurred fetching Google Drive files.");
		}

		const pathToFile = Object.fromEntries(
			files.map((file) => [file.properties.path, file])
		);

		const deletedFolders = paths.filter(
			(path) => pathToFile[path].properties.path === folderMimeType
		);

		if (deletedFolders.length) {
			const batches = foldersToBatches(deletedFolders);

			for (const batch of batches) {
				await Promise.all(
					batch.map((folder) => this.t.createFolder(folder))
				);
			}
		}

		const deletedFiles = paths.filter(
			(path) => pathToFile[path].properties.path !== folderMimeType
		);

		await batchAsyncs(
			deletedFiles.map((path) => async () => {
				const onlineFile = await this.t.drive
					.getFile(this.filePathToId[path])
					.arrayBuffer();
				if (!onlineFile) {
					return new Notice(
						"An error occurred fetching Google Drive files."
					);
				}
				return this.t.createFile(
					path,
					onlineFile,
					pathToFile[path].modifiedTime
				);
			})
		);
	}

	async handleCreate(path: string) {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!file) return;
		return this.t.deleteFile(file);
	}

	async handleModify(path: string) {
		const file = this.app.vault.getFileByPath(path);
		if (!file) return;

		const [onlineFile, metadata] = await Promise.all([
			this.t.drive.getFile(this.filePathToId[path]).arrayBuffer(),
			this.t.drive.getFileMetadata(this.filePathToId[path]),
		]);
		if (!onlineFile || !metadata) {
			return new Notice("An error occurred fetching Google Drive files.");
		}
		return this.t.modifyFile(file, onlineFile, metadata.modifiedTime);
	}
}

export const push = async (t: ObsidianGoogleDrive) => {
	if (t.syncing) return;
	
	// vault root ID를 한 번만 가져와서 전체 push 작업에서 재사용 (중복 생성 방지)
	const vaultRootId = await t.drive.getRootFolderId();
	if (!vaultRootId) {
		new Notice("Cannot get vault root folder ID. Please check your Google Drive connection.");
		return;
	}
	
	// 초기 동기화 자동 감지 및 실행
	const isFirstTime = await t.drive.isFirstTimeSync();
	if (isFirstTime) {
		const initialSyncResult = await t.drive.performInitialSync();
		if (initialSyncResult.success) {
			new Notice(`Auto-detected first sync: ${initialSyncResult.message}. Proceeding with push...`, 8000);
		} else {
			new Notice(`Initial sync warning: ${initialSyncResult.message}`);
			console.warn('Initial sync issues:', initialSyncResult.errors);
		}
	}
	
	const initialOperations = Object.entries(t.settings.operations).sort(
		([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)
	); // Alphabetical

	// operations가 없으면 동기화할 파일이 없다고 알림
	if (initialOperations.length === 0) {
		new Notice("No files to sync. Use 'Scan All Files' to add files to the sync queue.");
		return;
	}

	const { vault } = t.app;
	const adapter = vault.adapter;

	// 확인 모달 없이 바로 동기화 시작
	const syncNotice = await t.startSync();

	await pull(t, true);

	const operations = Object.entries(t.settings.operations);

	// 원작자와 동일: 단순히 DELETE → CREATE → MODIFY 순서로 처리
	const deletes = operations
		.filter(([_, op]) => op === "delete")
		.sort(([pathA], [pathB]) => {
			// 1. 깊이가 깊은 것부터 삭제
			const depthA = pathA.split('/').length;
			const depthB = pathB.split('/').length;
			if (depthA !== depthB) return depthB - depthA;
			
			// 2. 같은 깊이에서는 파일이 폴더보다 먼저 삭제되도록
			const { vault } = t.app;
			const fileA = vault.getAbstractFileByPath(pathA);
			const fileB = vault.getAbstractFileByPath(pathB);
			const isFileA = fileA instanceof TFile;
			const isFileB = fileB instanceof TFile;
			
			if (isFileA && !isFileB) return -1; // A가 파일, B가 폴더면 A 먼저
			if (!isFileA && isFileB) return 1;  // A가 폴더, B가 파일이면 B 먼저
			
			// 3. 같은 타입이면 알파벳 역순
			return pathB.localeCompare(pathA);
		});
		
	const creates = operations
		.filter(([_, op]) => op === "create")
		.sort(([pathA], [pathB]) => {
			// 1. 얕은 깊이부터 생성 (상위 폴더 먼저)
			const depthA = pathA.split('/').length;
			const depthB = pathB.split('/').length;
			if (depthA !== depthB) return depthA - depthB;
			
			// 2. 같은 깊이에서는 폴더가 파일보다 먼저 생성되도록
			const { vault } = t.app;
			const fileA = vault.getAbstractFileByPath(pathA);
			const fileB = vault.getAbstractFileByPath(pathB);
			const isFolderA = fileA instanceof TFolder;
			const isFolderB = fileB instanceof TFolder;
			
			if (isFolderA && !isFolderB) return -1; // A가 폴더, B가 파일이면 A 먼저
			if (!isFolderA && isFolderB) return 1;  // A가 파일, B가 폴더면 B 먼저
			
			// 3. 같은 타입이면 알파벳 순
			return pathA.localeCompare(pathB);
		});
		
	const modifies = operations.filter(([_, op]) => op === "modify");

	const pathsToIds = Object.fromEntries(
		Object.entries(t.settings.driveIdToPath).map(([id, path]) => [path, id])
	);

	// 전체 동기화 통계 추적
	const errorManager = ErrorManager.getInstance(t);
	let totalSuccessCount = 0;
	let totalFailureCount = 0;
	const totalOperations = creates.length + modifies.length;
	const successfulOperations = new Set<string>();

	const configOnDrive = await t.drive.searchFiles({
		include: ["properties"],
		matches: [{ properties: { config: "true" } }],
	});
	if (!configOnDrive) {
		return new Notice("An error occurred fetching Google Drive files.");
	}

	await Promise.all(
		configOnDrive.map(async ({ properties }) => {
			if (!(await adapter.exists(properties.path))) {
				deletes.push([properties.path, "delete"]);
			}
		})
	);

	// 1단계: 삭제 작업 처리
	if (deletes.length) {
		// Processing deletes in sorted order
		const deleteIds = deletes.map(([path]) => {
			const id = pathsToIds[path];
			// Delete mapping logged
			return id;
		}).filter(id => id); // undefined 제거
		
		// Delete IDs prepared
		
		if (deleteIds.length === 0) {
			console.warn('No valid IDs found for deletion');
			new Notice("Warning: Some files could not be deleted from Google Drive (IDs not found).");
		} else {
			try {
				const deleteRequest = await t.drive.batchDelete(deleteIds);
				if (!deleteRequest) {
					console.error('Delete request failed - no response');
					new Notice("An error occurred deleting Google Drive files.");
					return;
				}
				// Delete request completed
			} catch (error) {
				console.error('Delete request error:', error);
				new Notice("An error occurred deleting Google Drive files: " + error.message);
				return;
			}
		}
		deletes.forEach(([path]) => {
			delete t.settings.driveIdToPath[path];
			
			// 폴더 삭제 시 하위 파일들의 매핑도 정리
			if (path.endsWith('/') || vault.getAbstractFileByPath(path) instanceof TFolder) {
				const pathsToRemove = Object.keys(t.settings.driveIdToPath).filter(id => {
					const filePath = t.settings.driveIdToPath[id];
					return filePath && filePath.startsWith(path + '/');
				});
				
				pathsToRemove.forEach(id => {
					const filePath = t.settings.driveIdToPath[id];
					// Cleaning up deleted folder children
					delete t.settings.driveIdToPath[id];
					// operations에서도 정리
					if (t.settings.operations[filePath]) {
						delete t.settings.operations[filePath];
					}
				});
			}
		});
	}

	syncNotice.setMessage("Syncing 0% (0/" + totalOperations + ")");

	if (creates.length) {
		// Processing creates in sorted order
		let completed = 0;
		const files = creates.map(([path]) =>
			vault.getAbstractFileByPath(path)
		);

		const folders = files.filter(
			(file): file is TFolder => file instanceof TFolder
		);

		// 폴더 우선 처리: 계층구조 순서대로 안전하게 생성
		if (folders.length) {
			// Processing folders in hierarchy order
			const folderPaths = folders.map(f => f.path);
			
			try {
				// 새로운 안전한 폴더 동기화 사용
				await t.drive.syncFoldersHierarchy(folderPaths, pathsToIds);
				
				// 성공한 폴더들을 성공 목록에 추가
				folderPaths.forEach(path => {
					if (pathsToIds[path]) {
						successfulOperations.add(path);
						t.settings.driveIdToPath[pathsToIds[path]] = path;
					}
					completed++;
				});
				
			} catch (error) {
				console.error('Failed to sync folder hierarchy:', error);
				if (error.message?.includes('vault root not available')) {
					return new Notice('Cannot sync: Google Drive vault root is missing and could not be created. Please check your permissions and network connection.');
				}
				throw error;
			}
			
			const foldersCompleted = folders.length;
			const percentage = Math.floor((foldersCompleted / totalOperations) * 100);
			syncNotice.setMessage(`Syncing ${percentage}% (${foldersCompleted}/${totalOperations}) - Folders created`);
		}

		const notes = files.filter((file): file is TFile => file instanceof TFile);

		// 이미 가져온 vault root ID 재사용

		await batchAsyncs(
			notes.map((note) => async () => {
				try {
					// 루트 레벨 파일의 경우 vault root 폴더 ID를 사용
					let parentId: string | undefined;
					
					if (note.parent && note.parent.path !== "/") {
						// 실제 폴더에 있는 파일인 경우 (root가 아닌)
						parentId = pathsToIds[note.parent.path];
						if (!parentId) {
							console.warn(`Parent folder ID not found for ${note.path}, parent: ${note.parent.path}. Using vault root instead.`);
							parentId = vaultRootId;
						}
					} else {
						// 루트 레벨 파일인 경우 (note.parent가 null이거나 path가 "/")
						parentId = vaultRootId;
					}
					
					// 안전장치: parentId가 여전히 없으면 에러
					if (!parentId) {
						throw new Error(`Cannot determine parent folder ID for file: ${note.path}`);
					}
					
					// 디버깅: 파일 업로드 상세 정보 로그
					
					// 부모 폴더 ID 검증
					if (note.parent && note.parent.path !== "/" && parentId) {
						try {
							const parentExists = await t.drive.getFileMetadata(parentId);
						} catch (error) {
							console.error(`Parent folder verification failed:`, error);
						}
					}
					
					const id = await t.drive.uploadFile(
						new Blob([await vault.readBinary(note)]),
						note.name,
						parentId,
						{
							properties: { path: note.path },
							modifiedTime: new Date().toISOString(),
						}
					);
					
					if (!id) {
						throw new Error("Failed to get file ID from Google Drive");
					}

					t.settings.driveIdToPath[id] = note.path;
					
					// 성공 시 오류 기록에서 제거 및 성공 작업 추적
					await errorManager.removeErrors([note.path]);
					successfulOperations.add(note.path);
					totalSuccessCount++;
					
				} catch (error) {
					console.error(`Failed to upload file ${note.path}:`, error);
					await errorManager.addError(note.path, 'create', error);
					totalFailureCount++;
				}

				completed++;
				const currentTotal = totalSuccessCount + totalFailureCount;
				const percentage = Math.floor((currentTotal / totalOperations) * 100);
				const progressMsg = totalFailureCount > 0 
					? `Syncing ${percentage}% (${currentTotal}/${totalOperations}, ${totalFailureCount} failed)`
					: `Syncing ${percentage}% (${currentTotal}/${totalOperations})`;
				syncNotice.setMessage(progressMsg);
			})
		);
	}

	if (modifies.length) {
		let completed = 0;

		const files = modifies
			.map(([path]) => vault.getFileByPath(path))
			.filter((file): file is TFile => file instanceof TFile);

		const pathToId = Object.fromEntries(
			Object.entries(t.settings.driveIdToPath).map(([id, path]) => [
				path,
				id,
			])
		);

		await batchAsyncs(
			files.map((file) => async () => {
				try {
					if (!pathToId[file.path]) {
						throw new Error("No file ID found for modify operation");
					}
					
					const id = await t.drive.updateFile(
						pathToId[file.path],
						new Blob([await vault.readBinary(file)]),
						{ modifiedTime: new Date().toISOString() }
					);
					
					if (!id) {
						throw new Error("Failed to update file on Google Drive");
					}

					// 성공 시 오류 기록에서 제거 및 성공 작업 추적
					await errorManager.removeErrors([file.path]);
					successfulOperations.add(file.path);
					totalSuccessCount++;

				} catch (error: any) {
					// 404 오류 시 파일이 삭제된 것으로 간주하고 create로 변경
					if (error?.response?.status === 404) {
						// modify → create로 변경
						t.settings.operations[file.path] = "create";
						// 기존 ID 매핑 제거
						if (pathToId[file.path]) {
							delete t.settings.driveIdToPath[pathToId[file.path]];
						}
					} else {
						console.error(`Failed to modify file ${file.path}:`, error);
						await errorManager.addError(file.path, 'modify', error);
						totalFailureCount++;
					}
				}

				completed++;
				const currentTotal = totalSuccessCount + totalFailureCount;
				const percentage = Math.floor((currentTotal / totalOperations) * 100);
				const progressMsg = totalFailureCount > 0 
					? `Syncing ${percentage}% (${currentTotal}/${totalOperations}, ${totalFailureCount} failed)`
					: `Syncing ${percentage}% (${currentTotal}/${totalOperations})`;
				syncNotice.setMessage(progressMsg);
			})
		);
	}


	const configFilesToSync = await t.drive.getConfigFilesToSync();

	const foldersToCreate = new Set<string>();
	configFilesToSync.forEach((path) => {
		const parts = path.split("/");
		for (let i = 1; i < parts.length; i++) {
			foldersToCreate.add(parts.slice(0, i).join("/"));
		}
	});

	foldersToCreate.forEach((folder) => {
		if (pathsToIds[folder]) foldersToCreate.delete(folder);
	});

	if (foldersToCreate.size) {
		// Config 폴더도 계층구조 순서로 안전하게 생성
		await t.drive.syncFoldersHierarchy(Array.from(foldersToCreate), pathsToIds);
		
		// 생성된 폴더들에 config 속성 추가
		for (const folder of foldersToCreate) {
			if (pathsToIds[folder]) {
				// config 속성을 별도로 업데이트 (필요한 경우)
				t.settings.driveIdToPath[pathsToIds[folder]] = folder;
			}
		}
	}

	// 이미 가져온 vault root ID 재사용

	await batchAsyncs(
		configFilesToSync.map((path) => async () => {
			if (pathsToIds[path]) {
				try {
					await t.drive.updateFile(
						pathsToIds[path],
						new Blob([await adapter.readBinary(path)]),
						{ modifiedTime: new Date().toISOString() }
					);
					return;
				} catch (error: any) {
					// 404 오류 시 파일이 삭제된 것으로 간주하고 새로 생성
					if (error?.response?.status === 404) {
						delete t.settings.driveIdToPath[pathsToIds[path]];
						delete pathsToIds[path];
						// ID를 제거했으므로 아래 로직에서 새로 생성됨
					} else {
						throw error; // 다른 오류는 그대로 던짐
					}
				}
			}

			// 부모 폴더 경로 계산 (루트 레벨 파일 고려)
			const parentPath = path.split("/").slice(0, -1).join("/");
			let parentId: string | undefined;
			
			if (parentPath && parentPath !== "/") {
				parentId = pathsToIds[parentPath];
				if (!parentId) {
					console.warn(`Parent folder ID not found for config file ${path}, parent: ${parentPath}. Using vault root instead.`);
					parentId = vaultRootId;
				}
			} else {
				// 루트 레벨 config 파일인 경우 (parentPath가 빈 문자열이거나 "/")
				parentId = vaultRootId;
			}
			
			if (!parentId) {
				throw new Error(`Cannot determine parent folder ID for config file: ${path}`);
			}
			
			
			const id = await t.drive.uploadFile(
				new Blob([await adapter.readBinary(path)]),
				fileNameFromPath(path),
				parentId,
				{
					properties: { path, config: "true" },
					modifiedTime: new Date().toISOString(),
				}
			);
			if (!id) {
				return new Notice(
					"An error occurred creating Google Drive config files."
				);
			}

			t.settings.driveIdToPath[id] = path;
			pathsToIds[path] = id;
		})
	);

	// data.json 업데이트 (404 오류 시 새로 생성)
	const dataJsonPath = vault.configDir + "/plugins/google-drive-sync/data.json";
	const dataJsonId = pathsToIds[dataJsonPath];
	
	try {
		if (dataJsonId) {
			await t.drive.updateFile(
				dataJsonId,
				new Blob([JSON.stringify(t.settings, null, 2)]),
				{ modifiedTime: new Date().toISOString() }
			);
		} else {
			throw new Error("No data.json ID found, creating new file");
		}
	} catch (error: any) {
		// 404 오류 또는 ID가 없는 경우 새로 생성
		if (error?.response?.status === 404 || !dataJsonId) {
			const newId = await t.drive.uploadFile(
				new Blob([JSON.stringify(t.settings, null, 2)]),
				"data.json",
				pathsToIds[vault.configDir + "/plugins/google-drive-sync"],
				{
					properties: { path: dataJsonPath, config: "true" },
					modifiedTime: new Date().toISOString(),
				}
			);
			if (newId) {
				t.settings.driveIdToPath[newId] = dataJsonPath;
				pathsToIds[dataJsonPath] = newId;
			}
		} else {
			throw error; // 다른 오류는 그대로 던짐
		}
	}

	// 성공한 작업만 operations에서 제거, 실패한 작업은 다음 Push에서 재시도되도록 유지
	deletes.forEach(([path]) => {
		delete t.settings.operations[path]; // Delete 작업은 항상 성공으로 간주
	});
	
	successfulOperations.forEach(path => {
		delete t.settings.operations[path]; // 성공한 create/modify 작업만 제거
	});
	
	// 실패한 작업들은 t.settings.operations에 그대로 유지됨

	await t.endSync(syncNotice, false);

	// 전체 동기화 결과 알림
	if (totalFailureCount > 0) {
		new Notice(`Sync completed: ${totalSuccessCount} succeeded, ${totalFailureCount} failed. Check sync errors in settings for details.`, 10000);
	} else {
		new Notice("Sync completed successfully! All files synced without errors.");
	}
};
