import type {
	ExternalArtifact,
	RichArtifact,
	ExternalArtifactsConfig,
} from './types.js';
import {
	readJsonFile,
	getAllFilesMatching,
} from '@nomicfoundation/hardhat-utils/fs';
import path from 'node:path';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

/**
 * Package.json exports field types
 */
type ExportsField = string | null | ExportsConditions | ExportsMap;

interface ExportsConditions {
	[condition: string]: ExportsField;
}

interface ExportsMap {
	[subpath: string]: ExportsField;
}

export class ArtifactLoader {
	readonly #config: ExternalArtifactsConfig;
	readonly #projectRoot: string;

	constructor(config: ExternalArtifactsConfig, projectRoot: string) {
		this.#config = config;
		this.#projectRoot = projectRoot;
	}

	async loadAll(): Promise<ExternalArtifact[]> {
		const artifacts: ExternalArtifact[] = [];

		// Load from paths (relative/absolute filesystem paths)
		if (this.#config.paths) {
			for (const pathOrGlob of this.#config.paths) {
				const absolutePath = path.resolve(this.#projectRoot, pathOrGlob);
				artifacts.push(...(await this.#loadFromPath(absolutePath)));
			}
		}

		// Load from modules (node_modules resolution)
		if (this.#config.modules) {
			for (const moduleSpecifier of this.#config.modules) {
				const resolvedPath = await this.#resolveModulePath(moduleSpecifier);
				if (resolvedPath) {
					artifacts.push(...(await this.#loadFromPath(resolvedPath)));
				}
			}
		}

		// Load from resolver function
		if (this.#config.resolver) {
			const resolvedArtifacts = await this.#config.resolver();
			artifacts.push(...resolvedArtifacts);
		}

		return artifacts;
	}

	/**
	 * Resolves a module specifier to an absolute filesystem path.
	 * Supports package.json "exports" field patterns like "./artifacts/*".
	 *
	 * @param moduleSpecifier - e.g., "@my-org/contracts/artifacts"
	 * @returns The resolved absolute path, or undefined if resolution fails
	 */
	async #resolveModulePath(moduleSpecifier: string): Promise<string | undefined> {
		// Parse the module specifier into package name and subpath
		const {pkgName, subpath} = this.#parseModuleSpecifier(moduleSpecifier);

		try {
			// Find the package directory by locating its package.json
			const {pkgDir, pkgJson} = await this.#findPackage(pkgName);

			if (subpath && pkgJson.exports) {
				// Try to resolve the subpath using the exports field
				const resolvedSubpath = this.#resolveExportsSubpath(
					pkgJson.exports,
					`./${subpath}`,
				);

				if (resolvedSubpath) {
					const targetPath = path.join(pkgDir, resolvedSubpath);
					const stat = await fs.stat(targetPath).catch(() => null);
					if (stat) {
						return targetPath;
					}
				}
			}

			// Fallback: try direct path (for packages without exports or simple cases)
			if (subpath) {
				const targetPath = path.join(pkgDir, subpath);
				const stat = await fs.stat(targetPath).catch(() => null);
				if (stat) {
					return targetPath;
				}
			}

			// Try using import.meta.resolve for standard module resolution
			try {
				const resolvedUrl = import.meta.resolve(moduleSpecifier, `file://${this.#projectRoot}/`);
				const resolvedPath = fileURLToPath(resolvedUrl);
				const stat = await fs.stat(resolvedPath).catch(() => null);

				if (stat?.isDirectory()) {
					return resolvedPath;
				}

				if (stat?.isFile()) {
					// If it resolved to an index file, return the directory
					const basename = path.basename(resolvedPath);
					if (basename.startsWith('index.')) {
						return path.dirname(resolvedPath);
					}
					return resolvedPath;
				}
			} catch {
				// import.meta.resolve failed, continue to error handling
			}

			if (this.#config.warnOnInvalidArtifacts !== false) {
				console.warn(
					`[hardhat-external-artifacts] Could not resolve module path: ${moduleSpecifier}`,
				);
			}
			return undefined;

		} catch (error) {
			if (this.#config.warnOnInvalidArtifacts !== false) {
				console.warn(
					`[hardhat-external-artifacts] Failed to resolve module: ${moduleSpecifier}`,
					error instanceof Error ? error.message : error,
				);
			}
			return undefined;
		}
	}

	/**
	 * Find a package's directory and read its package.json.
	 * Handles packages with strict exports that don't include ./package.json.
	 */
	async #findPackage(pkgName: string): Promise<{pkgDir: string; pkgJson: {exports?: ExportsField}}> {
		const require = createRequire(path.join(this.#projectRoot, 'package.json'));

		// Try method 1: Direct package.json resolution (works for most packages)
		try {
			const pkgJsonPath = require.resolve(`${pkgName}/package.json`);
			const pkgDir = path.dirname(pkgJsonPath);
			const pkgJson = await readJsonFile(pkgJsonPath) as {exports?: ExportsField};
			return {pkgDir, pkgJson};
		} catch {
			// Package has strict exports, try alternative methods
		}

		// Try method 2: Resolve main entry and walk up to find package.json
		try {
			const mainEntry = require.resolve(pkgName);
			let dir = path.dirname(mainEntry);
			
			// Walk up the directory tree to find package.json
			while (dir !== path.dirname(dir)) { // Stop at filesystem root
				const pkgJsonPath = path.join(dir, 'package.json');
				try {
					const pkgJson = await readJsonFile(pkgJsonPath) as {name?: string; exports?: ExportsField};
					// Verify this is the correct package
					if (pkgJson.name === pkgName) {
						return {pkgDir: dir, pkgJson};
					}
				} catch {
					// No package.json here, continue walking up
				}
				dir = path.dirname(dir);
			}
		} catch {
			// Main entry resolution failed
		}

		// Try method 3: Search node_modules directly
		const nodeModulesPath = path.join(this.#projectRoot, 'node_modules', ...pkgName.split('/'));
		const pkgJsonPath = path.join(nodeModulesPath, 'package.json');
		try {
			const stat = await fs.stat(pkgJsonPath);
			if (stat.isFile()) {
				const pkgJson = await readJsonFile(pkgJsonPath) as {exports?: ExportsField};
				return {pkgDir: nodeModulesPath, pkgJson};
			}
		} catch {
			// Not found in direct node_modules
		}

		throw new Error(`Could not find package: ${pkgName}`);
	}

	/**
	 * Parse a module specifier into package name and subpath.
	 * Handles scoped packages (e.g., "@scope/pkg/subpath") and regular packages.
	 */
	#parseModuleSpecifier(specifier: string): {pkgName: string; subpath: string} {
		const parts = specifier.split('/');
		const isScoped = specifier.startsWith('@');

		if (isScoped) {
			return {
				pkgName: parts.slice(0, 2).join('/'),
				subpath: parts.slice(2).join('/'),
			};
		}

		return {
			pkgName: parts[0],
			subpath: parts.slice(1).join('/'),
		};
	}

	/**
	 * Resolve a subpath against a package.json exports field.
	 * Handles subpath patterns like "./artifacts/*": "./dist/artifacts/*"
	 *
	 * @param exports - The exports field from package.json
	 * @param subpath - The subpath to resolve (e.g., "./artifacts")
	 * @returns The resolved path relative to the package root, or undefined
	 */
	#resolveExportsSubpath(exports: ExportsField, subpath: string): string | undefined {
		if (exports === null) {
			return undefined;
		}

		if (typeof exports === 'string') {
			// Simple string export - only matches if subpath is "."
			return subpath === '.' ? exports : undefined;
		}

		if (typeof exports !== 'object') {
			return undefined;
		}

		// Check for exact match first
		if (subpath in exports) {
			return this.#resolveExportTarget(exports[subpath]);
		}

		// Check for pattern matches (e.g., "./artifacts/*")
		for (const [pattern, target] of Object.entries(exports)) {
			if (pattern.includes('*')) {
				const resolved = this.#matchExportPattern(pattern, target, subpath);
				if (resolved) {
					return resolved;
				}
			}
		}

		// Check for directory patterns (e.g., "./artifacts/" matches "./artifacts/anything")
		for (const [pattern, target] of Object.entries(exports)) {
			if (pattern.endsWith('/') && subpath.startsWith(pattern)) {
				const suffix = subpath.slice(pattern.length);
				const resolvedTarget = this.#resolveExportTarget(target);
				if (resolvedTarget) {
					return resolvedTarget.endsWith('/')
						? resolvedTarget + suffix
						: resolvedTarget + '/' + suffix;
				}
			}
		}

		return undefined;
	}

	/**
	 * Match a subpath against an export pattern with wildcards.
	 * E.g., pattern "./artifacts/*" with target "./dist/*" and subpath "./artifacts"
	 * would return "./dist"
	 */
	#matchExportPattern(
		pattern: string,
		target: ExportsField,
		subpath: string,
	): string | undefined {
		// Handle pattern like "./artifacts/*" matching "./artifacts" (the directory itself)
		const patternBase = pattern.replace('/*', '');
		
		if (subpath === patternBase) {
			// User wants the base directory, not a specific file
			// Resolve to the target base directory
			const resolvedTarget = this.#resolveExportTarget(target);
			if (resolvedTarget) {
				return resolvedTarget.replace('/*', '').replace(/\*$/, '');
			}
		}

		// Handle pattern matching for files within the directory
		if (subpath.startsWith(patternBase + '/')) {
			const wildcardValue = subpath.slice(patternBase.length + 1);
			const resolvedTarget = this.#resolveExportTarget(target);
			if (resolvedTarget && resolvedTarget.includes('*')) {
				return resolvedTarget.replace('*', wildcardValue);
			}
		}

		return undefined;
	}

	/**
	 * Resolve an export target, handling conditional exports.
	 */
	#resolveExportTarget(target: ExportsField): string | undefined {
		if (target === null) {
			return undefined;
		}

		if (typeof target === 'string') {
			return target;
		}

		if (typeof target !== 'object') {
			return undefined;
		}

		// Handle conditional exports - prefer 'import' for ESM, then 'default'
		const conditions = ['import', 'default', 'node', 'require'];
		for (const condition of conditions) {
			if (condition in target) {
				const result = this.#resolveExportTarget(target[condition]);
				if (result) {
					return result;
				}
			}
		}

		return undefined;
	}

	async #loadFromPath(absolutePath: string): Promise<ExternalArtifact[]> {
		let stat: Awaited<ReturnType<typeof fs.stat>>;

		try {
			stat = await fs.stat(absolutePath);
		} catch {
			// Path doesn't exist, return empty array
			if (this.#config.warnOnInvalidArtifacts !== false) {
				console.warn(
					`[hardhat-external-artifacts] Path not found: ${absolutePath}`,
				);
			}
			return [];
		}

		if (stat.isFile()) {
			try {
				return [await this.#loadArtifactFile(absolutePath)];
			} catch (error) {
				if (this.#config.warnOnInvalidArtifacts !== false) {
					console.warn(
						`[hardhat-external-artifacts] Failed to load artifact: ${absolutePath}`,
						error,
					);
				}
				return [];
			}
		}

		if (stat.isDirectory()) {
			// Support both .json and .ts artifact files
			const files = await getAllFilesMatching(absolutePath, (p) =>
				p.endsWith('.json'),
			);

			const loadedArtifacts: ExternalArtifact[] = [];
			for (const file of files) {
				try {
					loadedArtifacts.push(await this.#loadArtifactFile(file));
				} catch (error) {
					if (this.#config.warnOnInvalidArtifacts !== false) {
						console.warn(
							`[hardhat-external-artifacts] Failed to load artifact: ${file}`,
							error,
						);
					}
				}
			}
			return loadedArtifacts;
		}

		return [];
	}

	async #loadArtifactFile(filePath: string): Promise<ExternalArtifact> {
		const content = await readJsonFile(filePath);
		return this.#normalizeArtifact(content, filePath);
	}

	#normalizeArtifact(raw: any, source: string): ExternalArtifact {
		// Validate required fields - only ABI is truly required
		if (!raw.abi || !Array.isArray(raw.abi)) {
			throw new Error(
				`Artifact from ${source} is missing required field 'abi' or it's not an array`,
			);
		}

		// Infer contractName from filename if not provided
		// e.g., "/path/to/EIP173Proxy.json" -> "EIP173Proxy"
		let contractName = raw.contractName;
		if (!contractName || typeof contractName !== 'string') {
			const filename = path.basename(source, '.json');
			contractName = filename;
		}

		// Infer sourceName from filename if not provided
		// e.g., "EIP173Proxy" -> "external/EIP173Proxy.sol"
		let sourceName = raw.sourceName;
		if (!sourceName || typeof sourceName !== 'string') {
			sourceName = `external/${contractName}.sol`;
		}

		// Base artifact fields - required
		const artifact: ExternalArtifact = {
			contractName,
			sourceName,
			abi: raw.abi,
			bytecode: raw.bytecode ?? '0x',
			deployedBytecode: raw.deployedBytecode ?? '0x',
			linkReferences: raw.linkReferences ?? {},
			deployedLinkReferences: raw.deployedLinkReferences ?? {},
		};

		// Check if this is a "rich" artifact with embedded solcInput
		if (raw.solcInput) {
			// Rich artifact - has full compilation data
			(artifact as RichArtifact).solcInput = raw.solcInput;
			(artifact as RichArtifact).metadata = raw.metadata;
			(artifact as RichArtifact).evm = raw.evm;
			(artifact as RichArtifact).devdoc = raw.devdoc;
			(artifact as RichArtifact).userdoc = raw.userdoc;
			(artifact as RichArtifact).storageLayout = raw.storageLayout;
		}

		return artifact;
	}
}
