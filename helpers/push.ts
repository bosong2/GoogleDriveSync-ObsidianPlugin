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

	const { vault } = t.app;
	const adapter = vault.adapter;

	const proceed = await new Promise<boolean>((resolve) => {
		new ConfirmPushModal(t, initialOperations, resolve).open();
	});

	if (!proceed) return;

	const syncNotice = await t.startSync();

	await pull(t, true);

	const operations = Object.entries(t.settings.operations);

	const deletes = operations.filter(([_, op]) => op === "delete");
	const creates = operations.filter(([_, op]) => op === "create");
	const modifies = operations.filter(([_, op]) => op === "modify");

	const pathsToIds = Object.fromEntries(
		Object.entries(t.settings.driveIdToPath).map(([id, path]) => [path, id])
	);

	// 전체 동기화 통계 추적
	const errorManager = ErrorManager.getInstance(t);
	let totalSuccessCount = 0;
	let totalFailureCount = 0;
	const totalOperations = creates.length + modifies.length;

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

	if (deletes.length) {
		const deleteRequest = await t.drive.batchDelete(
			deletes.map(([path]) => pathsToIds[path])
		);
		if (!deleteRequest) {
			return new Notice("An error occurred deleting Google Drive files.");
		}
		deletes.forEach(([path]) => delete t.settings.driveIdToPath[path]);
	}

	syncNotice.setMessage("Syncing (33%)");

	if (creates.length) {
		let completed = 0;
		const files = creates.map(([path]) =>
			vault.getAbstractFileByPath(path)
		);

		const folders = files.filter(
			(file) => file instanceof TFolder
		) as TFolder[];

		if (folders.length) {
			const batches = foldersToBatches(folders);

			for (const batch of batches) {
				await batchAsyncs(
					batch.map((folder) => async () => {
						const id = await t.drive.createFolder({
							name: folder.name,
							parent: folder.parent
								? pathsToIds[folder.parent.path]
								: undefined,
							properties: { path: folder.path },
							modifiedTime: new Date().toISOString(),
						});
						if (!id) {
							return new Notice(
								"An error occurred creating Google Drive folders."
							);
						}

						completed++;
						syncNotice.setMessage(
							getSyncMessage(33, 66, completed, files.length)
						);

						t.settings.driveIdToPath[id] = folder.path;
						pathsToIds[folder.path] = id;
					})
				);
			}
		}

		const notes = files.filter((file) => file instanceof TFile) as TFile[];

		await batchAsyncs(
			notes.map((note) => async () => {
				try {
					const id = await t.drive.uploadFile(
						new Blob([await vault.readBinary(note)]),
						note.name,
						note.parent ? pathsToIds[note.parent.path] : undefined,
						{
							properties: { path: note.path },
							modifiedTime: new Date().toISOString(),
						}
					);
					
					if (!id) {
						throw new Error("Failed to get file ID from Google Drive");
					}

					t.settings.driveIdToPath[id] = note.path;
					
					// 성공 시 오류 기록에서 제거
					await errorManager.removeErrors([note.path]);
					totalSuccessCount++;
					
				} catch (error) {
					console.error(`Failed to upload file ${note.path}:`, error);
					await errorManager.addError(note.path, 'create', error);
					totalFailureCount++;
				}

				completed++;
				const progressMsg = totalFailureCount > 0 
					? `Syncing... (${totalSuccessCount + totalFailureCount}/${totalOperations} files, ${totalFailureCount} failed)`
					: getSyncMessage(33, 66, completed, files.length);
				syncNotice.setMessage(progressMsg);
			})
		);
	}

	if (modifies.length) {
		let completed = 0;

		const files = modifies
			.map(([path]) => vault.getFileByPath(path))
			.filter((file) => file instanceof TFile) as TFile[];

		const pathToId = Object.fromEntries(
			Object.entries(t.settings.driveIdToPath).map(([id, path]) => [
				path,
				id,
			])
		);

		await batchAsyncs(
			files.map((file) => async () => {
				try {
					const id = await t.drive.updateFile(
						pathToId[file.path],
						new Blob([await vault.readBinary(file)]),
						{ modifiedTime: new Date().toISOString() }
					);
					
					if (!id) {
						throw new Error("Failed to update file on Google Drive");
					}

					// 성공 시 오류 기록에서 제거
					await errorManager.removeErrors([file.path]);
					totalSuccessCount++;

				} catch (error) {
					console.error(`Failed to modify file ${file.path}:`, error);
					await errorManager.addError(file.path, 'modify', error);
					totalFailureCount++;
				}

				completed++;
				const currentTotal = totalSuccessCount + totalFailureCount;
				const progressMsg = totalFailureCount > 0 
					? `Syncing... (${currentTotal}/${totalOperations} files, ${totalFailureCount} failed)`
					: getSyncMessage(66, 99, completed, files.length);
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
		const batches = foldersToBatches(Array.from(foldersToCreate));

		for (const batch of batches) {
			await batchAsyncs(
				batch.map((folder) => async () => {
					const id = await t.drive.createFolder({
						name: folder.split("/").pop() || "",
						parent: pathsToIds[
							folder.split("/").slice(0, -1).join("/")
						],
						properties: { path: folder, config: "true" },
						modifiedTime: new Date().toISOString(),
					});
					if (!id) {
						return new Notice(
							"An error occurred creating Google Drive folders."
						);
					}

					t.settings.driveIdToPath[id] = folder;
					pathsToIds[folder] = id;
				})
			);
		}
	}

	await batchAsyncs(
		configFilesToSync.map((path) => async () => {
			if (pathsToIds[path]) {
				await t.drive.updateFile(
					pathsToIds[path],
					new Blob([await adapter.readBinary(path)]),
					{ modifiedTime: new Date().toISOString() }
				);
				return;
			}

			const id = await t.drive.uploadFile(
				new Blob([await adapter.readBinary(path)]),
				fileNameFromPath(path),
				pathsToIds[path.split("/").slice(0, -1).join("/")],
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

	await t.drive.updateFile(
		pathsToIds[vault.configDir + "/plugins/google-drive-sync/data.json"],
		new Blob([JSON.stringify(t.settings, null, 2)]),
		{ modifiedTime: new Date().toISOString() }
	);

	t.settings.operations = {};

	await t.endSync(syncNotice, false);

	// 전체 동기화 결과 알림
	if (totalFailureCount > 0) {
		new Notice(`Sync completed: ${totalSuccessCount} succeeded, ${totalFailureCount} failed. Check sync errors in settings for details.`, 10000);
	} else {
		new Notice("Sync completed successfully! All files synced without errors.");
	}
};
