import { checkConnection, getDriveClient, checkServer } from "helpers/drive";
import { refreshAccessToken } from "helpers/ky";
import { pull } from "helpers/pull";
import { push } from "helpers/push";
import { reset } from "helpers/reset";
import {
	App,
	debounce,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TAbstractFile,
	TFile,
	Menu,
} from "obsidian";

interface PluginSettings {
	refreshToken: string;
	operations: Record<string, "create" | "delete" | "modify">;
	driveIdToPath: Record<string, string>;
	lastSyncedAt: number;
	changesToken: string;
	ServerURL: string;
}

const DEFAULT_SETTINGS: PluginSettings = {
	refreshToken: "",
	operations: {},
	driveIdToPath: {},
	lastSyncedAt: 0,
	changesToken: "",
	ServerURL: "",
};

export default class ObsidianGoogleDrive extends Plugin {
	settings: PluginSettings;
	accessToken = {
		token: "",
		expiresAt: 0,
	};
	drive = getDriveClient(this);
	ribbonIcon: HTMLElement;
	syncing: boolean;

	async onload() {
		const { vault } = this.app;

		await this.loadSettings();

		this.addSettingTab(new SettingsTab(this.app, this));

		if (!this.settings.refreshToken) {
			new Notice(
				"Please add your refresh token to Google Drive Sync through our website or our readme/this plugin's settings. If you haven't already, PLEASE read through this plugin's readme or website CAREFULLY for instructions on how to use this plugin. If you don't know what you're doing, your data could get DELETED.",
				0
			);
			return;
		}

		this.ribbonIcon = this.addRibbonIcon(
			"refresh-cw",
			"Obsidian Google Drive",
			(event) => {
				if (this.syncing) return;
				const menu = new Menu();

				menu.addItem((item) =>
					item
						.setTitle("Pull from Drive")
						.setIcon("cloud-download")
						.onClick(() => {
							pull(this);
						})
				);

				menu.addItem((item) =>
					item
						.setTitle("Push to Drive")
						.setIcon("cloud-upload")
						.onClick(() => {
							push(this);
						})
				);
				menu.addItem((item) =>
					item
						.setTitle("Reset from Drive")
						.setIcon("triangle-alert")
						.onClick(() => {
							reset(this);
						})
				);
				menu.showAtMouseEvent(event);
			}
		);

		this.addCommand({
			id: "push",
			name: "Push to Google Drive",
			callback: () => push(this),
		});

		this.addCommand({
			id: "pull",
			name: "Pull from Google Drive",
			callback: () => pull(this),
		});

		this.addCommand({
			id: "reset",
			name: "Reset local vault to Google Drive",
			callback: () => reset(this),
		});

		this.registerEvent(
			this.app.workspace.on("quit", () => this.saveSettings())
		);

		this.app.workspace.onLayoutReady(() =>
			this.registerEvent(vault.on("create", this.handleCreate.bind(this)))
		);
		this.registerEvent(vault.on("delete", this.handleDelete.bind(this)));
		this.registerEvent(vault.on("modify", this.handleModify.bind(this)));
		this.registerEvent(vault.on("rename", this.handleRename.bind(this)));

		checkConnection(this).then(async (connected) => {
			if (connected) {
				this.syncing = true;
				this.ribbonIcon.addClass("spin");
				await pull(this, true);
				await this.endSync();
			}
		});
	}

	onunload() {
		return this.saveSettings();
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	saveSettings() {
		return this.saveData(this.settings);
	}

	debouncedSaveSettings = debounce(this.saveSettings.bind(this), 500, true);

	handleCreate(file: TAbstractFile) {
		if (file.path.includes(".DS_Store")) return;
		if (this.settings.operations[file.path] === "delete") {
			if (file instanceof TFile) {
				this.settings.operations[file.path] = "modify";
			} else {
				delete this.settings.operations[file.path];
			}
		} else {
			this.settings.operations[file.path] = "create";
		}
		this.debouncedSaveSettings();
	}

	handleDelete(file: TAbstractFile) {
		if (file.path.includes(".DS_Store")) return;
		if (this.settings.operations[file.path] === "create") {
			delete this.settings.operations[file.path];
		} else {
			this.settings.operations[file.path] = "delete";
		}
		this.debouncedSaveSettings();
	}

	handleModify(file: TFile) {
		if (file.path.includes(".DS_Store")) return;
		const operation = this.settings.operations[file.path];
		if (operation === "create" || operation === "modify") {
			return;
		}
		this.settings.operations[file.path] = "modify";
		this.debouncedSaveSettings();
	}

	handleRename(file: TAbstractFile, oldPath: string) {
		if (file.path.includes(".DS_Store")) return;
		this.handleDelete({ ...file, path: oldPath });
		this.handleCreate(file);
		this.debouncedSaveSettings();
	}

	async createFolder(path: string) {
		const oldOperation = this.settings.operations[path];
		await this.app.vault.createFolder(path);
		this.settings.operations[path] = oldOperation;
		if (!oldOperation) delete this.settings.operations[path];
	}

	async createFile(
		path: string,
		content: ArrayBuffer,
		modificationDate?: number | string | Date
	) {
		const oldOperation = this.settings.operations[path];
		if (typeof modificationDate === "string") {
			modificationDate = new Date(modificationDate);
		}
		if (modificationDate instanceof Date) {
			modificationDate = modificationDate.getTime();
		}

		await this.app.vault.createBinary(path, content, {
			mtime: modificationDate,
		});
		this.settings.operations[path] = oldOperation;
		if (!oldOperation) delete this.settings.operations[path];
	}

	async modifyFile(
		file: TFile,
		content: ArrayBuffer,
		modificationDate?: number | string | Date
	) {
		const oldOperation = this.settings.operations[file.path];
		if (typeof modificationDate === "string") {
			modificationDate = new Date(modificationDate);
		}
		if (modificationDate instanceof Date) {
			modificationDate = modificationDate.getTime();
		}

		await this.app.vault.modifyBinary(file, content, {
			mtime: modificationDate,
		});
		this.settings.operations[file.path] = oldOperation;
		if (!oldOperation) delete this.settings.operations[file.path];
	}

	async upsertFile(
		file: string,
		content: ArrayBuffer,
		modificationDate?: number | string | Date
	) {
		const oldOperation = this.settings.operations[file];
		if (typeof modificationDate === "string") {
			modificationDate = new Date(modificationDate);
		}
		if (modificationDate instanceof Date) {
			modificationDate = modificationDate.getTime();
		}

		await this.app.vault.adapter.writeBinary(file, content, {
			mtime: modificationDate,
		});
		this.settings.operations[file] = oldOperation;
		if (!oldOperation) delete this.settings.operations[file];
	}

	async deleteFile(file: TAbstractFile) {
		const oldOperation = this.settings.operations[file.path];
		await this.app.fileManager.trashFile(file);
		delete this.settings.operations[file.path];
		if (!oldOperation) delete this.settings.operations[file.path];
	}

	async startSync() {
		if (!(await checkConnection(this))) {
			throw new Notice(
				"You are not connected to the internet, so you cannot sync right now. Please try syncing once you have connection again."
			);
		}
		this.ribbonIcon.addClass("spin");
		this.syncing = true;
		return new Notice("Syncing (0%)", 0);
	}

	async endSync(syncNotice?: Notice, retainConfigChanges = true) {
		if (retainConfigChanges) {
			const configFilesToSync = await this.drive.getConfigFilesToSync();

			this.settings.lastSyncedAt = Date.now();

			await Promise.all(
				configFilesToSync.map(async (file) =>
					this.app.vault.adapter.writeBinary(
						file,
						await this.app.vault.adapter.readBinary(file),
						{ mtime: Date.now() }
					)
				)
			);
		} else {
			this.settings.lastSyncedAt = Date.now();
		}

		const changesToken = await this.drive.getChangesStartToken();
		if (!changesToken) {
			return new Notice(
				"An error occurred fetching Google Drive changes token."
			);
		}
		this.settings.changesToken = changesToken;
		await this.saveSettings();
		this.ribbonIcon.removeClass("spin");
		this.syncing = false;
		syncNotice?.hide();
	}
}

class SettingsTab extends PluginSettingTab {
	plugin: ObsidianGoogleDrive;

	constructor(app: App, plugin: ObsidianGoogleDrive) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();


		const linkEl = containerEl.createEl("a", { text: "Get refresh token" });
		linkEl.style.cursor = "pointer";
		linkEl.onclick = () => {
			if (this.plugin.settings.ServerURL) {
				window.open(this.plugin.settings.ServerURL, '_blank');
			} else {
				new Notice("Please set and save a Server URL below before getting a token.");
			}
		};

		let serverUrlInput = "";
		new Setting(containerEl)
			.setName("Server URL")
			.setDesc("Enter the custom server URL for token exchange.")
			.addText((text) => {
				text
					.setPlaceholder("https://example.com")
					.setValue(this.plugin.settings.ServerURL)
					.onChange((value) => {
						serverUrlInput = value;
					});
			})
			.addButton((button) => {
				button.setButtonText("Save").onClick(async () => {
					try {
						new URL(serverUrlInput);
					} catch (e) {
						new Notice("Invalid Server URL format.");
						return;
					}

					const isServerReachable = await checkServer(this.app, serverUrlInput);
					if (!isServerReachable) {
						new Notice("Server is not reachable. Please check the URL and server status.");
						return;
					}

					this.plugin.settings.ServerURL = serverUrlInput;
					await this.plugin.saveSettings();
					new Notice("Server URL saved successfully.");
				});
			});

		new Setting(containerEl)
			.setName("Refresh token")
			.setDesc("A refresh token is required to access your Google Drive.")
			.addText((text) => {
				text
					.setPlaceholder("Enter your refresh token")
					.setValue(this.plugin.settings.refreshToken)
					.onChange(async (value) => {
						this.plugin.settings.refreshToken = value;
					});
			})
			.addButton((button) => {
				button.setButtonText("Check").onClick(async () => {
					if (!this.plugin.settings.ServerURL) {
						new Notice("Please set and save the Server URL first.");
						return;
					}
					if (!this.plugin.settings.refreshToken) {
						new Notice("Please enter a refresh token.");
						return;
					}

					const success = await refreshAccessToken(this.plugin);
					if (success) {
						await this.plugin.saveSettings();
						new Notice("Refresh token is valid and has been saved!");
					} else {
						new Notice("Failed to validate refresh token. Please check the token and server settings.");
					}
				});
			});

		// Initial Sync 기능 추가
		new Setting(containerEl)
			.setName("Initial Vault Sync")
			.setDesc("Step 1: Scan and add all existing vault files to sync queue. After scanning, use 'Push' to upload them to Google Drive.")
			.addButton((button) => {
				button
					.setButtonText("Scan All Files")
					.onClick(async () => {
						if (!this.plugin.settings.refreshToken) {
							new Notice("Please set up your refresh token first.");
							return;
						}

						button.setDisabled(true);
						button.setButtonText("Scanning...");

						try {
							const result = await this.plugin.drive.performInitialSync();
							
							if (result.success) {
								new Notice(`${result.message}. Now use 'Push' (ribbon icon) to upload these files to Google Drive.`);
							} else {
								const errorMsg = result.errors && result.errors.length > 0 
									? `${result.message}\nErrors: ${result.errors.join(', ')}`
									: result.message;
								new Notice(errorMsg);
								console.error('Initial sync errors:', result.errors);
							}
						} catch (error) {
							new Notice(`Initial sync failed: ${error.message}`);
							console.error('Initial sync error:', error);
						} finally {
							button.setDisabled(false);
							button.setButtonText("Scan All Files");
						}
					});
			})

		// Operations 상태 표시 추가
		new Setting(containerEl)
			.setName("Sync Queue Status")
			.setDesc(`Currently tracking ${Object.keys(this.plugin.settings.operations).length} file operations. Use 'Push' to sync them to Google Drive.`)
			.addButton((button) => {
				button
					.setButtonText("View Queue")
					.onClick(() => {
						const operations = this.plugin.settings.operations;
						const operationsList = Object.entries(operations)
							.map(([path, op]) => `${op.toUpperCase()}: ${path}`)
							.slice(0, 20); // 첫 20개만 표시
						
						const totalCount = Object.keys(operations).length;
						const message = totalCount === 0 
							? "No files in sync queue."
							: `Sync Queue (${totalCount} files):\n\n${operationsList.join('\n')}${totalCount > 20 ? `\n\n... and ${totalCount - 20} more files` : ''}`;
						
						new Notice(message, 10000);
					});
			});

		// Reset 기능 추가
		new Setting(containerEl)
			.setName("Reset Sync State")
			.setDesc("Clear all tracked operations. Use only if you want to start fresh.")
			.addButton((button) => {
				button
					.setButtonText("Clear Operations")
					.setWarning()
					.onClick(async () => {
						if (confirm("Are you sure you want to clear all tracked file operations? This cannot be undone.")) {
							this.plugin.settings.operations = {};
							await this.plugin.saveSettings();
							new Notice("All operations cleared. Use 'Scan All Files' to rebuild the sync queue.");
						}
					});
			});
	}
}