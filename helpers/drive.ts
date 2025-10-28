import { App } from "obsidian";
import ky from "ky";
import ObsidianGoogleDrive from "main";
import { getDriveKy } from "./ky";
import { TAbstractFile, TFolder, TFile } from "obsidian";

export interface FileMetadata {
	id: string;
	name: string;
	description: string;
	mimeType: string;
	starred: boolean;
	properties: Record<string, string>;
	modifiedTime: string;
}

type StringSearch = string | { contains: string } | { not: string };
type DateComparison = { eq: string } | { gt: string } | { lt: string };

interface QueryMatch {
	name?: StringSearch | StringSearch[];
	mimeType?: StringSearch | StringSearch[];
	parent?: string;
	starred?: boolean;
	query?: string;
	properties?: Record<string, string>;
	modifiedTime?: DateComparison;
}

export const folderMimeType = "application/vnd.google-apps.folder";

const BLACKLISTED_CONFIG_FILES = [
	"graph.json",
	"workspace.json",
	"workspace-mobile.json",
];

const WHITELISTED_PLUGIN_FILES = [
	"manifest.json",
	"styles.css",
	"main.js",
	"data.json",
];

const stringSearchToQuery = (search: StringSearch) => {
	if (typeof search === "string") return `='${search}'`;
	if ("contains" in search) return ` contains '${search.contains}'`;
	if ("not" in search) return `!='${search.not}'`;
};

const queryHandlers = {
	name: (name: StringSearch) => "name" + stringSearchToQuery(name),
	mimeType: (mimeType: StringSearch) =>
		"mimeType" + stringSearchToQuery(mimeType),
	parent: (parent: string) => `'${parent}' in parents`,
	starred: (starred: boolean) => `starred=${starred}`,
	query: (query: string) => `fullText contains '${query}'`,
	properties: (properties: Record<string, string>) =>
		Object.entries(properties)
			.map(([key, value]) => `properties has { key='${key}' and value='${value}' }`)
			.join(" and "),
	modifiedTime: (modifiedTime: DateComparison) => {
		if ("eq" in modifiedTime) return `modifiedTime='${modifiedTime.eq}'`;
		if ("gt" in modifiedTime) return `modifiedTime>'${modifiedTime.gt}'`;
		if ("lt" in modifiedTime) return `modifiedTime<'${modifiedTime.lt}'`;
	},
};

export const fileListToMap = (files: { id: string; name: string }[]) =>
	Object.fromEntries(files.map(({ id, name }) => [name, id]));

export const getDriveClient = (t: ObsidianGoogleDrive) => {
	const drive = getDriveKy(t);

	const getQuery = (matches: QueryMatch[]) =>
		encodeURIComponent(
			`(${matches
				.map((match) => {
					const entries = Object.entries(match).flatMap(
						([key, value]) =>
							value === undefined
								? []
								: Array.isArray(value)
								? value.map((v) => [key, v])
								: [[key, value]]
					);
					return `(${entries
						.map(([key, value]) =>
							queryHandlers[key as keyof QueryMatch](
								value as never
							)
						)
						.join(" and ")})`;
				})
				.join(
					" or "
				)}) and trashed=false and properties has { key='vault' and value='${t.app.vault.getName()}' }`
		);

	const paginateFiles = async ({
		matches,
		pageToken,
		order = "descending",
		pageSize = 30,
		include = [
			"id",
			"name",
			"mimeType",
			"starred",
			"description",
			"properties",
		],
	}: {
		matches?: QueryMatch[];
		order?: "ascending" | "descending";
		pageToken?: string;
		pageSize?: number;
		include?: (keyof FileMetadata)[];
	}) => {
		const files = await drive
			.get(
				`drive/v3/files?fields=nextPageToken,files(${include.join(",")})&pageSize=${pageSize}&q=${matches ? getQuery(matches) : "trashed=false"}${matches?.find(({ query }) => query)? "": "&orderBy=name" +(order === "ascending" ? "" : " desc")}${pageToken ? "&pageToken=" + pageToken : ""}`
			)
			.json<any>();
		if (!files) return;
		return files as {
			nextPageToken?: string;
			files: FileMetadata[];
		};
	};

	const searchFiles = async (
		data: {
			matches?: QueryMatch[];
			order?: "ascending" | "descending";
			include?: (keyof FileMetadata)[];
		},
		includeObsidian = false
	) => {
		const files = await paginateFiles({ ...data, pageSize: 1000 });
		if (!files) return;

		while (files.nextPageToken) {
			const nextPage = await paginateFiles({
				...data,
				pageToken: files.nextPageToken,
				pageSize: 1000,
			});
			if (!nextPage) return;
			files.files.push(...nextPage.files);
			files.nextPageToken = nextPage.nextPageToken;
		}

		if (includeObsidian) return files.files as FileMetadata[];

		return files.files.filter(
			({ properties }) => properties?.obsidian !== "vault"
		) as FileMetadata[];
	};

	const getRootFolderId = async () => {
		const files = await searchFiles(
			{
				matches: [{ properties: { obsidian: "vault" } }],
			},
			true
		);
		if (!files) {
			console.error('Failed to search for vault root folder');
			return;
		}
		if (!files.length) {
			try {
				const rootFolder = await drive
					.post(`drive/v3/files`, {
						json: {
							name: t.app.vault.getName(),
							mimeType: folderMimeType,
							description: "Obsidian Vault: " + t.app.vault.getName(),
							properties: {
								obsidian: "vault",
								vault: t.app.vault.getName(),
							},
						},
					})
					.json<any>();
				if (!rootFolder) {
					console.error('Failed to create vault root folder');
					return;
				}
				console.log(`Created vault root folder: ${rootFolder.id}`);
				return rootFolder.id as string;
			} catch (error) {
				console.error('Error creating vault root folder:', error);
				return;
			}
		} else {
			return files[0].id as string;
		}
	};

	const createFolder = async ({
		name,
		parent,
		description,
		properties,
		modifiedTime,
	}: {
		name: string;
		description?: string;
		parent?: string;
		properties?: Record<string, string>;
		modifiedTime?: string;
	}) => {
		if (!parent) {
			parent = await getRootFolderId();
			if (!parent) {
				console.error('Failed to get or create vault root folder');
				throw new Error('Cannot create folder: vault root not available');
			}
		}

		if (!properties) properties = {};
		if (!properties.vault) properties.vault = t.app.vault.getName();

		// 중복 폴더 체크: 같은 부모 아래 같은 이름의 폴더가 이미 있는지 확인
		const existingFolders = await searchFiles({
			include: ["id", "name"],
			matches: [
				{ name, mimeType: folderMimeType, parent }
			],
		});

		if (existingFolders && existingFolders.length > 0) {
			return existingFolders[0].id;
		}

		const folder = await drive
			.post(`drive/v3/files`, {
				json: {
					name,
					mimeType: folderMimeType,
					description,
					parents: [parent],
					properties,
					modifiedTime,
				},
			})
			.json<any>();
		if (!folder) return;
		return folder.id as string;
	};

	const uploadFile = async (
		file: Blob,
		name: string,
		parent?: string,
		metadata?: Partial<Omit<FileMetadata, "id">>
	) => {
		if (!parent) {
			parent = await getRootFolderId();
			if (!parent) return;
		}

		if (!metadata) metadata = {};
		if (!metadata.properties) metadata.properties = {};
		if (!metadata.properties.vault) {
			metadata.properties.vault = t.app.vault.getName();
		}

		const form = new FormData();
		form.append(
			"metadata",
			new Blob(
				[
					JSON.stringify({
						name,
						mimeType: file.type,
						parents: [parent],
						...metadata,
					}),
				],
				{ type: "application/json" }
			)
		);
		form.append("file", file);

		const result = await drive
			.post(`upload/drive/v3/files?uploadType=multipart&fields=id`, {
				body: form,
			})
			.json<any>();
		if (!result) return;

		return result.id as string;
	};

	const updateFile = async (
		id: string,
		newContent: Blob,
		newMetadata: Partial<Omit<FileMetadata, "id">> = {}
	) => {
		const form = new FormData();
		form.append(
			"metadata",
			new Blob([JSON.stringify(newMetadata)], {
				type: "application/json",
			})
		);
		form.append("file", newContent);

		const result = await drive
			.patch(
				`upload/drive/v3/files/${id}?uploadType=multipart&fields=id`,
				{
					body: form,
				}
			)
			.json<any>();
		if (!result) return;

		return result.id as string;
	};

	const updateFileMetadata = async (
		id: string,
		metadata: Partial<Omit<FileMetadata, "id">>
	) => {
		const result = await drive
			.patch(`drive/v3/files/${id}`, {
				json: metadata,
			})
			.json<any>();
		if (!result) return;
		return result.id as string;
	};

	const deleteFile = async (id: string) => {
		const result = await drive.delete(`drive/v3/files/${id}`);
		if (!result.ok) return;
		return true;
	};

	const getFile = (id: string) =>
		drive.get(`drive/v3/files/${id}?alt=media&acknowledgeAbuse=true`);

	const getFileMetadata = (id: string) =>
		drive.get(`drive/v3/files/${id}`).json<FileMetadata>();

	const idFromPath = async (path: string) => {
		const files = await searchFiles({
			matches: [{ properties: { path } }],
		});
		if (!files?.length) return;
		return files[0].id as string;
	};

	const idsFromPaths = async (paths: string[]) => {
		const files = await searchFiles({
			matches: paths.map((path) => ({ properties: { path } })),
		});
		if (!files) return;
		return files.map((file) => ({
			id: file.id,
			path: file.properties.path,
		}));
	};

	const batchDelete = async (ids: string[]) => {
		console.log(`batchDelete called with IDs:`, ids);
		
		if (!ids.length) {
			console.warn('batchDelete: No IDs provided');
			return false;
		}

		const body = new FormData();

		// Loop through file IDs to create each delete request
		ids.forEach((fileId, index) => {
			const deleteRequest = [
				`--batch_boundary`,
				"Content-Type: application/http",
				"",
				`DELETE /drive/v3/files/${fileId} HTTP/1.1`,
				"",
				"",
			].join("\r\n");

			body.append(`request_${index + 1}`, deleteRequest);
		});

		body.append("", "--batch_boundary--");

		try {
			const result = await drive
				.post(`batch/drive/v3`, {
					headers: {
						"Content-Type": "multipart/mixed; boundary=batch_boundary",
					},
					body,
				})
				.text();
			
			console.log(`batchDelete response:`, result);
			
			if (!result) {
				console.error('batchDelete: No response from Google Drive');
				return false;
			}
			
			// 성공/실패 여부를 응답에서 확인 (Google Drive delete는 204 No Content 반환)
			const successPattern = /HTTP\/1\.1 (200 OK|204 No Content)/g;
			const errorPattern = /HTTP\/1\.1 4\d\d|HTTP\/1\.1 5\d\d/g;
			
			const successCount = (result.match(successPattern) || []).length;
			const errorCount = (result.match(errorPattern) || []).length;
			
			console.log(`batchDelete results: ${successCount} successful, ${errorCount} failed out of ${ids.length} requests`);
			
			return result;
		} catch (error) {
			console.error('batchDelete error:', error);
			throw error;
		}
	};

	const getChangesStartToken = async () => {
		const result = await drive
			.get(`drive/v3/changes/startPageToken`)
			.json<any>();
		if (!result) return;
		return result.startPageToken as string;
	};

	const getChanges = async (startToken: string) => {
		if (!startToken) return [];

		const request = (token: string) =>
			drive
				.get(
					`drive/v3/changes?${new URLSearchParams({
						pageToken: token,
						pageSize: "1000",
						includeRemoved: "true",
					}).toString()}`
				)
				.json<any>();

		const result = await request(startToken);
		if (!result) return;
		while (result.nextPageToken) {
			const nextPage = await request(result.nextPageToken);
			if (!nextPage) return;
			result.changes.push(...nextPage.changes);
			result.newStartPageToken = nextPage.newStartPageToken;
			result.nextPageToken = nextPage.nextPageToken;
		}

		return result.changes as {
			kind: string;
			removed: boolean;
			file: FileMetadata;
			fileId: string;
			time: string;
		}[];
	};

	const deleteFilesMinimumOperations = async (files: TAbstractFile[]) => {
		const folders = files.filter(
			(file): file is TFolder => file instanceof TFolder
		);

		if (folders.length) {
			const maxDepth = Math.max(
				...folders.map(({ path }) => path.split("/").length)
			);

			for (let depth = 1; depth <= maxDepth; depth++) {
				const foldersToDelete = files.filter(
					(file) =>
						file instanceof TFolder &&
						file.path.split("/").length === depth
				);
				await Promise.all(
					foldersToDelete.map((folder) => t.deleteFile(folder))
				);
				foldersToDelete.forEach(
					(folder) =>
						(files = files.filter(
							({ path }) =>
								!path.startsWith(folder.path + "/") &&
								path !== folder.path
						))
				);
			}
		}

		await Promise.all(files.map((file) => t.deleteFile(file)));
	};

	const getConfigFilesToSync = async () => {
		const configFilesToSync: string[] = [];
		const { vault } = t.app;
		const { adapter } = vault;

		const [configFiles, plugins] = await Promise.all([
			adapter.list(vault.configDir),
			adapter.list(vault.configDir + "/plugins"),
		]);

		await Promise.all(
			configFiles.files
				.filter(
					(path) =>
						!BLACKLISTED_CONFIG_FILES.includes(
							fileNameFromPath(path)
						)
				)
				.map(async (path) => {
					const file = await adapter.stat(path);
					if ((file?.mtime || 0) > t.settings.lastSyncedAt) {
						configFilesToSync.push(path);
					}
				})
				.concat(
					plugins.folders.map(async (plugin) => {
						const files = await adapter.list(plugin);
						await Promise.all(
							files.files
								.filter((path) =>
									WHITELISTED_PLUGIN_FILES.includes(
										fileNameFromPath(path)
									)
								)
								.map(async (path) => {
									const file = await adapter.stat(path);
									if (
										(file?.mtime || 0) >
										t.settings.lastSyncedAt
									) {
										configFilesToSync.push(path);
									}
								})
						);
					})
				)
		);

		return configFilesToSync;
	};

	// 전체 볼트 파일 스캔 (초기 동기화용)
	const getAllVaultFiles = async () => {
		const allFiles: string[] = [];
		const allFolders: string[] = [];
		const { vault } = t.app;
		
		console.log('Starting vault scan using Obsidian API...');
		
		// Obsidian API로 모든 파일 가져오기 (더 안전함)
		const allVaultFiles = vault.getAllLoadedFiles();
		const errorFilePath = `${t.manifest.dir}/error.json`;
		
		const configDirPath = vault.configDir;
		
		allVaultFiles.forEach(file => {
			// 파일인 경우
			if (file instanceof TFile) {
				if (!file.path.startsWith(configDirPath + '/') && 
					!file.path.includes('.DS_Store') &&
					!file.path.includes('.git/') &&
					file.path !== errorFilePath) {
					allFiles.push(file.path);
				} else {
				}
			}
			// 폴더인 경우  
			else if (file instanceof TFolder) {
				if (!file.path.startsWith(configDirPath + '/') && 
					!file.path.includes('.git/') &&
					file.path !== '/' && file.path !== '') {  // 루트 폴더 제외
					allFolders.push(file.path);
				} else {
				}
			}
		});
		
		
		// 기존 adapter 방식도 병행 (비교용)
		
		const scanFolder = async (folderPath: string) => {
			try {
				const folderContents = await vault.adapter.list(folderPath);
				
				
				// 파일들 추가 (config 파일 및 error.json 제외)
				folderContents.files.forEach(filePath => {
					const errorFilePath = `${t.manifest.dir}/error.json`;
					const shouldInclude = !filePath.startsWith((t.app.vault.configDir || '.obsidian') + '/') && 
						!filePath.includes('.DS_Store') &&
						!filePath.includes('.git/') &&
						filePath !== errorFilePath;
					
					
					if (shouldInclude) {
						allFiles.push(filePath);
					}
				});
				
				// 폴더들 추가 및 재귀 스캔
				for (const subFolder of folderContents.folders) {
					if (!subFolder.startsWith((t.app.vault.configDir || '.obsidian') + '/') && 
						!subFolder.includes('.git/')) {
						allFolders.push(subFolder);
						await scanFolder(subFolder);
					}
				}
			} catch (error) {
				console.warn(`Failed to scan folder ${folderPath}:`, error);
			}
		};
		
		await scanFolder('');
		
		
		return { files: allFiles, folders: allFolders };
	};

	// 초기 동기화 필요 여부 확인
	const isFirstTimeSync = async () => {
		try {
			const rootFolderId = await getRootFolderId();
			if (!rootFolderId) return true;
			
			const existingFiles = await searchFiles({
				matches: [{ parent: rootFolderId }],
				include: ['id']
			});
			
			return !existingFiles || existingFiles.length === 0;
		} catch (error) {
			console.warn('Failed to check first-time sync:', error);
			return false;
		}
	};

	// 폴더 구조를 안전하게 순차 생성
	const syncFoldersHierarchy = async (folderPaths: string[], pathsToIds: Record<string, string>) => {
		// 폴더를 깊이별로 정렬 (root부터 처리)
		const sortedPaths = folderPaths.sort((a, b) => {
			const depthA = a.split('/').length;
			const depthB = b.split('/').length;
			if (depthA !== depthB) return depthA - depthB;
			return a.localeCompare(b); // 같은 깊이면 알파벳 순
		});

		// 루트 폴더 ID를 미리 한 번만 가져와서 재사용 (중복 생성 방지)
		const vaultRootId = await getRootFolderId();
		if (!vaultRootId) {
			console.error('Failed to get vault root folder ID');
			return;
		}

		for (const folderPath of sortedPaths) {
			// 이미 ID가 있는 폴더는 건너뛰기
			if (pathsToIds[folderPath]) {
				continue;
			}

			const parts = folderPath.split('/');
			const folderName = parts[parts.length - 1];
			const parentPath = parts.slice(0, -1).join('/');
			
			// 부모 폴더 ID 찾기
			let parentId: string | undefined;
			if (parentPath) {
				parentId = pathsToIds[parentPath];
				if (!parentId) {
					console.error(`Parent folder not found for ${folderPath}, parent: ${parentPath}`);
					continue;
				}
			} else {
				// 루트 레벨 폴더인 경우 미리 가져온 루트 ID 사용
				parentId = vaultRootId;
			}

			try {
				const folderId = await createFolder({
					name: folderName,
					parent: parentId,
					properties: { path: folderPath },
					modifiedTime: new Date().toISOString(),
				});

				if (folderId) {
					pathsToIds[folderPath] = folderId;
				} else {
					console.error(`No folder ID returned for ${folderPath}`);
				}
			} catch (error) {
				console.error(`Failed to create folder ${folderPath}:`, error);
				// vault root 문제인 경우 전체 프로세스 중단
				if (error.message?.includes('vault root not available')) {
					throw error;
				}
			}
		}

		return pathsToIds;
	};

	const createFoldersSequentially = async (folderPaths: string[]) => {
		// 폴더 깊이별로 정렬 (얕은 것부터)
		const sortedFolders = folderPaths.sort((a, b) => {
			const depthA = a.split('/').length;
			const depthB = b.split('/').length;
			if (depthA !== depthB) return depthA - depthB;
			return a.localeCompare(b); // 같은 깊이면 알파벳순
		});

		const pathsToIds = Object.fromEntries(
			Object.entries(t.settings.driveIdToPath).map(([id, path]) => [path, id])
		);

		// 루트 폴더 ID를 미리 한 번만 가져와서 재사용 (중복 생성 방지)
		const vaultRootId = await getRootFolderId();
		if (!vaultRootId) {
			console.error('Failed to get vault root folder ID');
			return { createdCount: 0, errors: ['Failed to get vault root folder ID'] };
		}

		let createdCount = 0;
		const errors: string[] = [];

		for (const folderPath of sortedFolders) {
			try {
				// 이미 존재하는 폴더는 건너뛰기
				if (pathsToIds[folderPath]) {
					continue;
				}

				const folderName = folderPath.split('/').pop() || '';
				const parentPath = folderPath.split('/').slice(0, -1).join('/');
				const parentId = parentPath ? pathsToIds[parentPath] : vaultRootId;

				if (!parentId) {
					errors.push(`Parent folder not found for: ${folderPath}`);
					continue;
				}

				const folderId = await createFolder({
					name: folderName,
					parent: parentId,
					properties: { path: folderPath },
					modifiedTime: new Date().toISOString(),
				});

				if (folderId) {
					t.settings.driveIdToPath[folderId] = folderPath;
					pathsToIds[folderPath] = folderId;
					createdCount++;
				} else {
					errors.push(`Failed to create folder: ${folderPath}`);
				}
			} catch (error) {
				errors.push(`Error creating folder ${folderPath}: ${error.message}`);
			}
		}

		return { createdCount, errors };
	};

	// 초기 동기화 실행
	// Google Drive의 모든 파일 상태를 가져오는 함수
	const getAllDriveFiles = async () => {
		try {
			const allFiles = await searchFiles({
				include: ["id", "properties", "mimeType", "modifiedTime"],
				matches: [] // 모든 파일 검색
			});
			
			if (!allFiles) return [];
			
			// properties.path가 있는 파일들만 반환 (config 속성 없는 파일들)
			return allFiles.filter(file => 
				file.properties?.path && 
				!file.properties.config
			);
		} catch (error) {
			console.error('Failed to get all drive files:', error);
			return [];
		}
	};

	const performInitialSync = async (options = { showProgress: true }) => {
		try {
			
			// 1. 로컬 파일 스캔
			const { files, folders } = await getAllVaultFiles();
			
			if (files.length === 0 && folders.length === 0) {
				return { success: true, message: 'No files to sync', filesAdded: 0, foldersCreated: 0 };
			}

			// 2. Google Drive 현재 상태 확인
			const driveFiles = await getAllDriveFiles();
			
			// 3. data.json 상태 확인
			const pathsToIds = Object.fromEntries(
				Object.entries(t.settings.driveIdToPath).map(([id, path]) => [path, id])
			);

			// 4. 폴더 처리 (우선 처리)
			let foldersCreated = 0;
			let folderErrors: string[] = [];
			const foldersToCreate: string[] = [];
			
			folders.forEach(folderPath => {
				const existsInData = pathsToIds[folderPath];
				const existsOnDrive = driveFiles.find(f => f.properties.path === folderPath);
				
				if (!existsInData && !existsOnDrive) {
					// 새 폴더 → CREATE 필요
					foldersToCreate.push(folderPath);
				} else if (!existsInData && existsOnDrive) {
					// data.json 누락 → data.json 업데이트만
					pathsToIds[folderPath] = existsOnDrive.id;
					t.settings.driveIdToPath[existsOnDrive.id] = folderPath;
				} else if (existsInData && !existsOnDrive) {
					// Drive에서 삭제됨 → CREATE 필요
					foldersToCreate.push(folderPath);
				} else {
					// 정상 상태
				}
			});
			
			if (foldersToCreate.length > 0) {
				const folderResult = await createFoldersSequentially(foldersToCreate);
				foldersCreated = folderResult.createdCount;
				folderErrors = folderResult.errors;
			}

			// 5. 파일 처리
			let filesAdded = 0;
			const filesToCreate: string[] = [];
			
			files.forEach(filePath => {
				// operations queue에 이미 있으면 스킵
				if (t.settings.operations[filePath]) {
					return;
				}
				
				const existsInData = pathsToIds[filePath];
				const existsOnDrive = driveFiles.find(f => f.properties.path === filePath);
				
				if (!existsInData && !existsOnDrive) {
					// 새 파일 → CREATE
					t.settings.operations[filePath] = "create";
					filesAdded++;
				} else if (!existsInData && existsOnDrive) {
					// data.json 누락 → data.json 업데이트만
					pathsToIds[filePath] = existsOnDrive.id;
					t.settings.driveIdToPath[existsOnDrive.id] = filePath;
				} else if (existsInData && !existsOnDrive) {
					// Drive에서 삭제됨 → CREATE
					t.settings.operations[filePath] = "create";
					filesAdded++;
				} else {
					// 정상 상태 (둘 다 존재)
				}
			});

			// 6. 설정 저장
			await t.saveSettings();

			const allErrors = [...folderErrors];
			const success = allErrors.length === 0;

			return {
				success,
				filesAdded,
				foldersCreated,
				errors: allErrors,
				message: success 
					? `Scan completed: ${filesAdded} files to sync, ${foldersCreated} folders created`
					: `Scan completed with errors: ${filesAdded} files, ${foldersCreated} folders (${allErrors.length} errors)`
			};
		} catch (error) {
			console.error('performInitialSync error:', error);
			return {
				success: false,
				filesAdded: 0,
				foldersCreated: 0,
				errors: [error.message],
				message: `Scan failed: ${error.message}`
			};
		}
	};

	return {
		paginateFiles,
		searchFiles,
		getRootFolderId,
		createFolder,
		uploadFile,
		updateFile,
		updateFileMetadata,
		deleteFile,
		getFile,
		getFileMetadata,
		idFromPath,
		idsFromPaths,
		getChangesStartToken,
		getChanges,
		batchDelete,
		checkConnection,
		deleteFilesMinimumOperations,
		getConfigFilesToSync,
		getAllVaultFiles,
		getAllDriveFiles,
		isFirstTimeSync,
		createFoldersSequentially,
		syncFoldersHierarchy,
		performInitialSync,
	};
};

export const checkConnection = async (t: ObsidianGoogleDrive) => {
	try {
		const result = await ky.get(`${t.settings.ServerURL}/api/ping`);
		return result.ok;
	} catch (e) {
		console.error("Connection check failed in checkConnection:", e);
		return false;
	}
};

export const checkServer = async (app: App, url: string) => {
	try {
		const result = await ky.get(`${url}/api/ping`);
		return result.ok;
	} catch (e) {
		console.error("Server check failed in checkServer:", e);
		return false;
	}
};

export const batchAsyncs = async (
	requests: (() => Promise<any>)[],
	batchSize?: number
) => {
	// 동적 배치 크기 계산: 요청 수에 따라 적응적으로 조정
	const adaptiveBatchSize = batchSize || Math.min(20, Math.max(5, Math.ceil(requests.length / 4)));
	
	const results = [];
	const batches = [];
	
	// 모든 배치를 미리 생성
	for (let i = 0; i < requests.length; i += adaptiveBatchSize) {
		const batch = requests.slice(i, i + adaptiveBatchSize);
		batches.push(batch);
	}
	
	// 모든 배치를 동시에 처리 (순차 대기 제거)
	const batchPromises = batches.map(async (batch) => {
		return Promise.all(batch.map((request) => request()));
	});
	
	const batchResults = await Promise.all(batchPromises);
	
	// 결과 평탄화
	for (const batchResult of batchResults) {
		results.push(...batchResult);
	}
	
	return results;
};

export const getSyncMessage = (
	min: number,
	max: number,
	completed: number,
	total: number
) => {
	const percentage = Math.floor(min + (max - min) * (completed / total));
	return `Syncing ${percentage}% (${completed}/${total})`;
};

export const fileNameFromPath = (path: string) => path.split("/").slice(-1)[0];

/**
 * @returns Batches in increasing order of depth
 */
export const foldersToBatches: {
	(folders: string[]): string[][];
	(folders: TFolder[]): TFolder[][];
} = (folders) => {
	const batches: (typeof folders)[] = new Array(
		Math.max(
			...folders.map(
				(folder) =>
					(folder instanceof TFolder ? folder.path : folder).split(
						"/"
					).length
			)
		)
	)
		.fill(0)
		.map(() => []);

	folders.forEach((folder) => {
		batches[
			(folder instanceof TFolder ? folder.path : folder).split("/")
				.length - 1
		].push(folder as any);
	});

	return batches as any;
};