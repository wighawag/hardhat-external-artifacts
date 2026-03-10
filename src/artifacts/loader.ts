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

export class ArtifactLoader {
	readonly #config: ExternalArtifactsConfig;
	readonly #projectRoot: string;

	constructor(config: ExternalArtifactsConfig, projectRoot: string) {
		this.#config = config;
		this.#projectRoot = projectRoot;
	}

	async loadAll(): Promise<ExternalArtifact[]> {
		const artifacts: ExternalArtifact[] = [];

		// Load from paths
		if (this.#config.paths) {
			for (const pathOrGlob of this.#config.paths) {
				const absolutePath = path.resolve(this.#projectRoot, pathOrGlob);
				artifacts.push(...(await this.#loadFromPath(absolutePath)));
			}
		}

		// Load from resolver function
		if (this.#config.resolver) {
			const resolvedArtifacts = await this.#config.resolver();
			artifacts.push(...resolvedArtifacts);
		}

		return artifacts;
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
		// Validate required fields
		if (!raw.contractName || typeof raw.contractName !== 'string') {
			throw new Error(
				`Artifact from ${source} is missing required field 'contractName'`,
			);
		}
		if (!raw.sourceName || typeof raw.sourceName !== 'string') {
			throw new Error(
				`Artifact from ${source} is missing required field 'sourceName'`,
			);
		}
		if (!raw.abi || !Array.isArray(raw.abi)) {
			throw new Error(
				`Artifact from ${source} is missing required field 'abi' or it's not an array`,
			);
		}

		// Base artifact fields - required
		const artifact: ExternalArtifact = {
			contractName: raw.contractName,
			sourceName: raw.sourceName,
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
