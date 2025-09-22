import { App } from "obsidian";
import ky from "ky";
import ObsidianGoogleDrive from "main";
import { getDriveKy } from "./ky";
import { TAbstractFile, TFolder } from "obsidian";

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
		Object.entries(properties).map(
			([key, value]) =>
				`properties has { key='${key}' and value='${value}' }`
		),
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
		if (!files) return;
		if (!files.length) {
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
			if (!rootFolder) return;
			return rootFolder.id as string;
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
			if (!parent) return;
		}

		if (!properties) properties = {};
		if (!properties.vault) properties.vault = t.app.vault.getName();

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

		const result = await drive
			.post(`batch/drive/v3`, {
				headers: {
					"Content-Type": "multipart/mixed; boundary=batch_boundary",
				},
				body,
			})
			.text();
		if (!result) return;
		return result;
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
			(file) => file instanceof TFolder
		) as TFolder[];

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
		
		const scanFolder = async (folderPath: string) => {
			try {
				const folderContents = await vault.adapter.list(folderPath);
				
				// 파일들 추가 (config 파일 및 error.json 제외)
				folderContents.files.forEach(filePath => {
					const errorFilePath = `${t.manifest.dir}/error.json`;
					if (!filePath.startsWith('.obsidian/') && 
						!filePath.includes('.DS_Store') &&
						!filePath.includes('.git/') &&
						filePath !== errorFilePath) {
						allFiles.push(filePath);
					}
				});
				
				// 폴더들 추가 및 재귀 스캔
				for (const subFolder of folderContents.folders) {
					if (!subFolder.startsWith('.obsidian/') && 
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
				const parentId = parentPath ? pathsToIds[parentPath] : await getRootFolderId();

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
	const performInitialSync = async (options = { showProgress: true }) => {
		try {
			const { files, folders } = await getAllVaultFiles();
			
			if (files.length === 0 && folders.length === 0) {
				return { success: true, message: 'No files to sync', filesAdded: 0, foldersCreated: 0 };
			}

			// 1. 폴더 순차 생성
			let foldersCreated = 0;
			let folderErrors: string[] = [];
			
			if (folders.length > 0) {
				const folderResult = await createFoldersSequentially(folders);
				foldersCreated = folderResult.createdCount;
				folderErrors = folderResult.errors;
			}

			// 2. 파일들을 operations에 추가
			let filesAdded = 0;
			files.forEach(filePath => {
				if (!t.settings.operations[filePath]) {
					t.settings.operations[filePath] = "create";
					filesAdded++;
				}
			});

			// 설정 저장
			await t.saveSettings();

			const allErrors = [...folderErrors];
			const success = allErrors.length === 0;

			return {
				success,
				filesAdded,
				foldersCreated,
				errors: allErrors,
				message: success 
					? `Initial sync ready: ${filesAdded} files, ${foldersCreated} folders`
					: `Partial sync: ${filesAdded} files, ${foldersCreated} folders (${allErrors.length} errors)`
			};
		} catch (error) {
			return {
				success: false,
				filesAdded: 0,
				foldersCreated: 0,
				errors: [error.message],
				message: `Initial sync failed: ${error.message}`
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
		isFirstTimeSync,
		createFoldersSequentially,
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
	batchSize = 10
) => {
	const results = [];
	for (let i = 0; i < requests.length; i += batchSize) {
		const batch = requests.slice(i, i + batchSize);
		results.push(...(await Promise.all(batch.map((request) => request()))));
	}
	return results;
};

export const getSyncMessage = (
	min: number,
	max: number,
	completed: number,
	total: number
) => `Syncing (${Math.floor(min + (max - min) * (completed / total))}%)`;

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