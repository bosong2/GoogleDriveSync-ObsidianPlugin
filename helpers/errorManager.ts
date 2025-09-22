import ObsidianGoogleDrive from "main";
import { Notice } from "obsidian";

export interface SyncError {
    filePath: string;
    errorType: 'network' | 'permission' | 'file_size' | 'timeout' | 'rate_limit' | 'unknown';
    errorMessage: string;
    timestamp: number;
    retryCount: number;
    lastAttempt: string;
    operation: 'create' | 'modify' | 'delete';
}

export interface ErrorLog {
    version: string;
    errors: SyncError[];
    lastUpdated: number;
}

export interface SyncProgress {
    total: number;
    completed: number;
    succeeded: number;
    failed: number;
}

const getErrorFilePath = (t: ObsidianGoogleDrive) => {
    return `${t.manifest.dir}/error.json`;
}

// 오류 타입 분류 함수
export const classifyError = (error: any): SyncError['errorType'] => {
    const errorMsg = error?.message?.toLowerCase() || '';
    
    if (errorMsg.includes('network') || errorMsg.includes('connection')) {
        return 'network';
    } else if (errorMsg.includes('permission') || errorMsg.includes('forbidden') || errorMsg.includes('unauthorized')) {
        return 'permission';
    } else if (errorMsg.includes('size') || errorMsg.includes('too large')) {
        return 'file_size';
    } else if (errorMsg.includes('timeout') || errorMsg.includes('timed out')) {
        return 'timeout';
    } else if (errorMsg.includes('rate limit') || errorMsg.includes('quota')) {
        return 'rate_limit';
    } else {
        return 'unknown';
    }
};

export class ErrorManager {
    private static instance: ErrorManager | null = null;
    private t: ObsidianGoogleDrive;
    private errorFilePath: string;

    private constructor(plugin: ObsidianGoogleDrive) {
        this.t = plugin;
        this.errorFilePath = `${plugin.manifest.dir}/error.json`;
    }

    public static getInstance(plugin: ObsidianGoogleDrive): ErrorManager {
        if (!ErrorManager.instance) {
            ErrorManager.instance = new ErrorManager(plugin);
        }
        return ErrorManager.instance;
    }

    public static resetInstance(): void {
        ErrorManager.instance = null;
    }

    async loadErrors(): Promise<SyncError[]> {
        try {
            if (!await this.t.app.vault.adapter.exists(this.errorFilePath)) {
                return [];
            }
            const content = await this.t.app.vault.adapter.read(this.errorFilePath);
            const errorLog: ErrorLog = JSON.parse(content);
            return errorLog.errors || [];
        } catch (error) {
            console.error("Failed to load error.json:", error);
            return [];
        }
    }

    async saveErrors(errors: SyncError[]): Promise<void> {
        try {
            const errorLog: ErrorLog = {
                version: "1.0.0",
                errors: errors,
                lastUpdated: Date.now()
            };
            await this.t.app.vault.adapter.write(this.errorFilePath, JSON.stringify(errorLog, null, 2));
        } catch (error) {
            console.error("Failed to save error.json:", error);
            throw error;
        }
    }

    async addError(filePath: string, operation: SyncError['operation'], error: any): Promise<void> {
        const errors = await this.loadErrors();
        const existingIndex = errors.findIndex(e => e.filePath === filePath);

        const syncError: SyncError = {
            filePath,
            errorType: classifyError(error),
            errorMessage: error.message || String(error),
            timestamp: Date.now(),
            retryCount: existingIndex >= 0 ? errors[existingIndex].retryCount + 1 : 1,
            lastAttempt: new Date().toISOString(),
            operation
        };

        if (existingIndex >= 0) {
            errors[existingIndex] = syncError;
        } else {
            errors.push(syncError);
        }

        await this.saveErrors(errors);
    }

    async removeErrors(filePaths: string[]): Promise<void> {
        const errors = await this.loadErrors();
        const filteredErrors = errors.filter(error => !filePaths.includes(error.filePath));
        await this.saveErrors(filteredErrors);
    }

    async clearAllErrors(): Promise<void> {
        await this.saveErrors([]);
    }

    async getErrorCount(): Promise<number> {
        const errors = await this.loadErrors();
        return errors.length;
    }

    async getRetriableErrors(): Promise<SyncError[]> {
        const errors = await this.loadErrors();
        return errors.filter(error => 
            error.retryCount < 3 && 
            ['network', 'timeout', 'rate_limit'].includes(error.errorType)
        );
    }

    async incrementRetryCount(filePath: string): Promise<void> {
        const errors = await this.loadErrors();
        const errorIndex = errors.findIndex(e => e.filePath === filePath);
        
        if (errorIndex >= 0) {
            errors[errorIndex].retryCount++;
            errors[errorIndex].lastAttempt = new Date().toISOString();
            await this.saveErrors(errors);
        }
    }
}

// 하위 호환성을 위한 레거시 함수들
export const readErrors = async (t: ObsidianGoogleDrive): Promise<SyncError[]> => {
    const errorManager = ErrorManager.getInstance(t);
    return await errorManager.loadErrors();
};

export const logError = async (t: ObsidianGoogleDrive, path: string, error: Error) => {
    const errorManager = ErrorManager.getInstance(t);
    await errorManager.addError(path, 'create', error);
};