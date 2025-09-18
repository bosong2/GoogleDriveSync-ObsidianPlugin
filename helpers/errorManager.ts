import ObsidianGoogleDrive from "main";

export interface SyncError {
    path: string;
    retryCount: number;
    lastAttempt: number;
    error: string;
}

const getErrorFilePath = (t: ObsidianGoogleDrive) => {
    return `${t.manifest.dir}/error.json`;
}

export const readErrors = async (t: ObsidianGoogleDrive): Promise<SyncError[]> => {
    const path = getErrorFilePath(t);
    if (!await t.app.vault.adapter.exists(path)) {
        return [];
    }
    const content = await t.app.vault.adapter.read(path);
    try {
        return JSON.parse(content);
    } catch (e) {
        console.error("Failed to parse error.json:", e);
        return [];
    }
};

const writeErrors = async (t: ObsidianGoogleDrive, errors: SyncError[]) => {
    const path = getErrorFilePath(t);
    await t.app.vault.adapter.write(path, JSON.stringify(errors, null, 2));
};

export const logError = async (t: ObsidianGoogleDrive, path: string, error: Error) => {
    const errors = await readErrors(t);
    const existingErrorIndex = errors.findIndex(e => e.path === path);

    if (existingErrorIndex > -1) {
        // Update existing error
        errors[existingErrorIndex].retryCount++;
        errors[existingErrorIndex].lastAttempt = Date.now();
        errors[existingErrorIndex].error = error.message;
    } else {
        // Add new error
        errors.push({
            path,
            retryCount: 1,
            lastAttempt: Date.now(),
            error: error.message,
        });
    }

    await writeErrors(t, errors);
};