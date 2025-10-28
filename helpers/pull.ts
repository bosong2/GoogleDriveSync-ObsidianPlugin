import ObsidianGoogleDrive from "main";
import { Notice, TFile, TFolder } from "obsidian";
import {
	batchAsyncs,
	FileMetadata,
	folderMimeType,
	foldersToBatches,
	getSyncMessage,
} from "./drive";
import { refreshAccessToken } from "./ky";

interface ConflictInfo {
	hasConflict: boolean;
	reason: 'content_diff' | 'time_diff' | 'no_conflict';
	localModified: number;
	remoteModified: number;
	sizeDiff: boolean;
}

// 충돌 감지 함수
const detectConflict = async (t: ObsidianGoogleDrive, localFile: TFile, remoteFile: FileMetadata): Promise<ConflictInfo> => {
	const localStat = await t.app.vault.adapter.stat(localFile.path);
	const localModified = localStat?.mtime || 0;
	const remoteModified = new Date(remoteFile.modifiedTime).getTime();
	
	// 시간 차이 임계값 (5초) - 네트워크 지연 고려
	const timeDiffThreshold = 5000;
	const timeDiff = Math.abs(localModified - remoteModified);
	
	// 파일 크기 비교
	const localSize = localStat?.size || 0;
	const localContent = await t.app.vault.readBinary(localFile);
	const localContentSize = localContent.byteLength;
	
	// 원격 파일 크기는 metadata에서 가져올 수 없으므로 내용을 다운로드해서 비교
	const remoteContent = await t.drive.getFile(remoteFile.id).arrayBuffer();
	const sizeDiff = localContentSize !== remoteContent.byteLength;
	
	// 충돌 판정 로직
	let hasConflict = false;
	let reason: ConflictInfo['reason'] = 'no_conflict';
	
	if (sizeDiff) {
		// 크기가 다르면 확실한 충돌
		hasConflict = true;
		reason = 'content_diff';
	} else if (timeDiff > timeDiffThreshold) {
		// 시간 차이가 크고 크기가 같으면 잠재적 충돌
		// 내용을 실제로 비교
		const localArray = new Uint8Array(localContent);
		const remoteArray = new Uint8Array(remoteContent);
		
		// 바이트 단위 비교
		for (let i = 0; i < localArray.length; i++) {
			if (localArray[i] !== remoteArray[i]) {
				hasConflict = true;
				reason = 'content_diff';
				break;
			}
		}
		
		if (!hasConflict && timeDiff > timeDiffThreshold) {
			reason = 'time_diff';
		}
	}
	
	return {
		hasConflict,
		reason,
		localModified,
		remoteModified,
		sizeDiff
	};
};

// 충돌 처리 함수
const handleConflict = async (t: ObsidianGoogleDrive, localFile: TFile, remoteFile: FileMetadata, conflict: ConflictInfo) => {
	const localTime = new Date(conflict.localModified).toLocaleString();
	const remoteTime = new Date(conflict.remoteModified).toLocaleString();
	
	// 충돌 파일 백업 생성
	const backupPath = `${localFile.path}.conflict-${Date.now()}.backup`;
	const remoteContent = await t.drive.getFile(remoteFile.id).arrayBuffer();
	
	try {
		await t.app.vault.createBinary(backupPath, remoteContent);
		
		const message = `Sync Conflict Detected!\n\n` +
			`File: ${localFile.path}\n` +
			`Local modified: ${localTime}\n` +
			`Remote modified: ${remoteTime}\n\n` +
			`Remote version saved as:\n${backupPath}\n\n` +
			`Please manually resolve the conflict.`;
		
		new Notice(message, 15000);
		console.warn('Sync conflict:', {
			file: localFile.path,
			conflict,
			backupPath
		});
		
	} catch (error) {
		console.error('Failed to create conflict backup:', error);
		new Notice(`Conflict detected in ${localFile.path} but failed to create backup. Remote changes ignored.`, 8000);
	}
};

export const pull = async (
	t: ObsidianGoogleDrive,
	silenceNotices?: boolean
) => {
	let syncNotice: any = null;

	if (!silenceNotices) {
		if (t.syncing) return;
		syncNotice = await t.startSync();
	}

	const { vault } = t.app;
	const adapter = vault.adapter;

	if (!t.accessToken.token) await refreshAccessToken(t);

	// 원작자와 동일한 시간 비교 (여유 시간 제거)
	const safeLastSyncTime = new Date(t.settings.lastSyncedAt);
	
	const recentlyModified = await t.drive.searchFiles({
		include: ["id", "modifiedTime", "properties", "mimeType"],
		matches: [
			{
				modifiedTime: {
					gt: safeLastSyncTime.toISOString(),
				},
			},
		],
	});
	if (!recentlyModified) {
		return new Notice("An error occurred fetching Google Drive files.");
	}

	const changes = await t.drive.getChanges(t.settings.changesToken);
	if (!changes) {
		return new Notice("An error occurred fetching Google Drive changes.");
	}

	const deletions = changes
		.filter(({ removed }) => removed)
		.map(({ fileId }) => {
			const path = t.settings.driveIdToPath[fileId];
			if (!path) return;
			delete t.settings.driveIdToPath[fileId];

			const file = vault.getAbstractFileByPath(path);

			if (!file && t.settings.operations[path] === "delete") {
				delete t.settings.operations[path];
				return;
			}
			return file;
		});

	if (!recentlyModified.length && !deletions.length) {
		if (silenceNotices) return;
		t.endSync(syncNotice);
		return new Notice("You're up to date!");
	}

	const pathToId = Object.fromEntries(
		Object.entries(t.settings.driveIdToPath).map(([id, path]) => [path, id])
	);

	const updateMap = () => {
		recentlyModified.forEach(({ id, properties }) => {
			pathToId[properties.path] = id;
		});

		t.settings.driveIdToPath = Object.fromEntries(
			Object.entries(pathToId).map(([path, id]) => [id, path])
		);
	};

	updateMap();

	const deleteFiles = async () => {
		const deletedFiles = deletions
			.filter((file): file is TFile => file instanceof TFile)
			.filter((file: TFile) => {
				if (t.settings.operations[file.path] === "modify") {
					if (!pathToId[file.path]) {
						t.settings.operations[file.path] = "create";
					}
					return;
				}
				return true;
			});

		const deletionPaths = deletions.map((file) => file?.path);

		const deletedFolders = deletions
			.filter((folder): folder is TFolder => folder instanceof TFolder)
			.filter((folder: TFolder) => {
				if (pathToId[folder.path]) return;
				if (
					folder.children.find(
						({ path }) => !deletionPaths.includes(path)
					)
				) {
					return true;
				}
				t.settings.operations[folder.path] = "create";
			});

		await t.drive.deleteFilesMinimumOperations([
			...deletedFolders,
			...deletedFiles,
		]);
	};

	await deleteFiles();

	syncNotice?.setMessage("Syncing (33%)");

	const upsertFiles = async () => {
		const newFolders = recentlyModified.filter(
			({ mimeType }) => mimeType === folderMimeType
		);

		if (newFolders.length) {
			const batches = foldersToBatches(
				newFolders.map(({ properties }) => properties.path)
			);

			for (const batch of batches) {
				await Promise.all(
					batch.map(async (folder) => {
						delete t.settings.operations[folder];
						if (
							vault.getFolderByPath(folder) ||
							(await adapter.exists(folder))
						) {
							return;
						}
						return t.createFolder(folder);
					})
				);
			}
		}

		let completed = 0;
		let conflictCount = 0; // 충돌 발생 횟수 추적

		const newNotes = recentlyModified.filter(
			({ mimeType }) => mimeType !== folderMimeType
		);

		await batchAsyncs(
			newNotes.map((file: FileMetadata) => async () => {
				const localFile =
					vault.getFileByPath(file.properties.path) ||
					(await adapter.exists(file.properties.path));
				const operation = t.settings.operations[file.properties.path];

				completed++;

				// 충돌 감지 및 처리
				if (localFile instanceof TFile && operation === "modify") {
					// 로컬에서 수정 중이고 원격에서도 변경된 경우 = 충돌 상황
					const conflict = await detectConflict(t, localFile, file);
					if (conflict.hasConflict) {
						await handleConflict(t, localFile, file, conflict);
						conflictCount++;
						return;
					}
					// 충돌이 없으면 원격 변경사항 무시 (로컬 우선)
					return;
				}

				if (localFile && operation === "create") {
					t.settings.operations[file.properties.path] = "modify";
					return;
				}

				const content = await t.drive.getFile(file.id).arrayBuffer();

				syncNotice?.setMessage(
					getSyncMessage(33, 100, completed, newNotes.length)
				);

				if (localFile instanceof TFile) {
					return t.modifyFile(localFile, content, file.modifiedTime);
				}

				return t.upsertFile(
					file.properties.path,
					content,
					file.modifiedTime
				);
			})
		);
		
		return conflictCount;
	};

	const conflictCount = await upsertFiles();

	const deleteConfigs = async () => {
		const configDeletions = await Promise.all(
			changes
				.filter(({ removed }) => removed)
				.map(async ({ fileId }) => {
					const path = t.settings.driveIdToPath[fileId];
					if (!path || vault.getAbstractFileByPath(path)) return;
					const stat = await adapter.stat(path);
					if (!stat) return;
					return { path, type: stat.type };
				})
		);

		let configDeletionsFiltered = configDeletions.filter(Boolean) as {
			path: string;
			type: "file" | "folder";
		}[];

		const trashMethod = (vault as any).getConfig("trashOption");

		if (trashMethod === "local" || trashMethod === "system") {
			const deletionMethod =
				trashMethod === "local"
					? adapter.trashLocal
					: adapter.trashSystem;

			const folders = configDeletionsFiltered.filter(
				(file) => file.type === "folder"
			);

			if (folders.length) {
				const maxDepth = Math.max(
					...folders.map(({ path }) => path.split("/").length)
				);

				for (let depth = 1; depth <= maxDepth; depth++) {
					const foldersToDelete = configDeletionsFiltered.filter(
						(file) =>
							file.type === "folder" &&
							file.path.split("/").length === depth
					);
					await Promise.all(
						foldersToDelete.map(({ path }) => deletionMethod(path))
					);
					foldersToDelete.forEach(
						(folder) =>
							(configDeletionsFiltered =
								configDeletionsFiltered.filter(
									({ path }) =>
										!path.startsWith(folder.path + "/") &&
										path !== folder.path
								))
					);
				}
			}

			return Promise.all(
				configDeletionsFiltered.map(({ path }) => deletionMethod(path))
			);
		}

		const deletedFiles = configDeletionsFiltered.filter(
			(file) => file.type === "file"
		);
		await Promise.all(deletedFiles.map(({ path }) => adapter.remove(path)));

		const deletedFolders = configDeletionsFiltered.filter(
			(file) => file.type === "folder"
		);
		const batches = foldersToBatches(
			deletedFolders.map(({ path }) => path)
		);
		batches.reverse();

		for (const batch of batches) {
			await Promise.all(
				batch.map(async (folder) => {
					const list = await adapter.list(folder);
					if (list.files.length + list.folders.length) return;
					adapter.rmdir(folder, false);
				})
			);
		}
	};

	await deleteConfigs();

	if (silenceNotices) return;

	await t.endSync(syncNotice);

	// 충돌 발생 시 특별한 알림
	if (conflictCount > 0) {
		new Notice(`Pull completed with ${conflictCount} conflict(s). Please check .conflict.backup files and resolve manually.`, 10000);
	} else {
		new Notice("Files have been synced from Google Drive!");
	}
};
