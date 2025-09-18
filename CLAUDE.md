# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an Obsidian plugin that syncs vault data with Google Drive. It's a modified version of Richard Xiong's original Google Drive Sync plugin, enhanced to support custom authentication servers.

**Key Features:**
- Bidirectional sync (Obsidian ↔ Google Drive)
- Multi-device support (Windows, macOS, iOS tested)
- Local file priority with automatic conflict resolution
- Custom authentication server support

## Development Commands

### Build and Development
```bash
# Development build with watch mode
npm run dev

# Production build with type checking
npm run build

# Install dependencies
npm install

# Audit and fix vulnerabilities
npm audit fix --force
```

### Type Checking and Linting
- TypeScript compilation: `tsc -noEmit -skipLibCheck` (part of build process)
- ESLint configuration available in `.eslintrc`
- No explicit lint command in package.json

### Version Management
```bash
# Bump version and update manifest
npm run version
```

## Architecture

### Core Files
- `main.ts` - Main plugin class extending Obsidian Plugin
- `manifest.json` - Plugin metadata and Obsidian compatibility info

### Helper Modules (`helpers/`)
- `drive.ts` - Google Drive API client and file operations
- `pull.ts` - Pull changes from Google Drive to local vault
- `push.ts` - Push local changes to Google Drive
- `reset.ts` - Reset local vault to match Google Drive state
- `ky.ts` - HTTP client wrapper for authentication
- `errorManager.ts` - Error handling utilities

### Key Interfaces
```typescript
interface PluginSettings {
    refreshToken: string;
    operations: Record<string, "create" | "delete" | "modify">;
    driveIdToPath: Record<string, string>;
    lastSyncedAt: number;
    changesToken: string;
    ServerURL: string;
}
```

### Plugin Structure
- Main plugin class: `ObsidianGoogleDrive`
- Settings management with dedicated settings tab
- Ribbon icon with sync menu (Pull/Push/Reset)
- Command palette integration
- Real-time file change tracking with debounced sync

### Dependencies
- `ky` - Modern HTTP client for authentication requests
- `obsidian` - Obsidian plugin API
- Various TypeScript and build dependencies

### Build Configuration
- ESBuild for bundling (`esbuild.config.mjs`)
- TypeScript target: ES6, module: ESNext
- Output: `main.js` (bundled plugin file)
- Development includes inline source maps

### File Filtering
The plugin implements selective sync with:
- Blacklisted config files: `graph.json`, `workspace.json`, `workspace-mobile.json`
- Whitelisted plugin files: `manifest.json`, `styles.css`, `main.js`, `data.json`

### Authentication Flow
1. User configures custom server URL in settings
2. Server URL validation on save
3. Refresh token obtained from custom server
4. Token validation and access token refresh handled automatically

## Important Notes

- The plugin requires a custom authentication server (not included in this repo)
- Always backup vault data before using sync features
- Local files take priority in conflict resolution
- Plugin supports cross-platform sync including mobile devices