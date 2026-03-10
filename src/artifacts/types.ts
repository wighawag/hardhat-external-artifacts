/**
 * A minimal artifact format that can be provided externally.
 * Supports both Hardhat v2 and v3 formats.
 */
export interface ExternalArtifact {
	/** Contract name */
	contractName: string;

	/** Source file path/identifier */
	sourceName: string;

	/** Contract ABI */
	abi: readonly any[];

	/** Deployment bytecode (0x-prefixed) */
	bytecode: string;

	/** Deployed/runtime bytecode (0x-prefixed) */
	deployedBytecode: string;

	/** Library link references for deployment bytecode */
	linkReferences?: LinkReferences;

	/** Library link references for deployed bytecode */
	deployedLinkReferences?: LinkReferences;
}

/**
 * A rich artifact that includes embedded solcInput and full compilation data.
 * This is the format from hardhat-deploy or other tools that preserve
 * the full compilation output.
 */
export interface RichArtifact extends ExternalArtifact {
	/** The full solc compiler input JSON (stringified) */
	solcInput?: string;

	/** Contract metadata JSON (contains solc version, settings, etc.) */
	metadata?: string;

	/** Full EVM output including generated sources, source maps, etc. */
	evm?: {
		bytecode: {
			object: string;
			opcodes: string;
			sourceMap: string;
			linkReferences: LinkReferences;
			generatedSources?: any[];
			functionDebugData?: Record<string, any>;
		};
		deployedBytecode: {
			object: string;
			opcodes: string;
			sourceMap: string;
			linkReferences: LinkReferences;
			immutableReferences?: Record<
				string,
				Array<{start: number; length: number}>
			>;
			generatedSources?: any[];
			functionDebugData?: Record<string, any>;
		};
		methodIdentifiers?: Record<string, string>;
		gasEstimates?: any;
	};

	/** Developer documentation */
	devdoc?: any;

	/** User documentation */
	userdoc?: any;

	/** Storage layout */
	storageLayout?: any;
}

export interface LinkReferences {
	[sourceName: string]: {
		[libraryName: string]: Array<{start: number; length: number}>;
	};
}

/**
 * Type guard to check if an artifact is a rich artifact
 */
export function isRichArtifact(
	artifact: ExternalArtifact,
): artifact is RichArtifact {
	return 'solcInput' in artifact && artifact.solcInput !== undefined;
}

/**
 * Function type for dynamically resolving artifacts
 */
export type ArtifactResolver = () =>
	| Promise<ExternalArtifact[]>
	| ExternalArtifact[];

/**
 * Configuration for external artifacts
 */
export interface ExternalArtifactsConfig {
	/**
	 * Paths to artifact files or directories (relative to project root)
	 * - File path: loads single artifact JSON
	 * - Directory path: loads all .json files recursively
	 */
	paths?: string[];

	/**
	 * Module specifiers to resolve from node_modules
	 * Uses Node.js module resolution to find exported artifact directories.
	 *
	 * @example
	 * ```ts
	 * // If @my-org/contracts exports "./artifacts" in package.json:
	 * // "exports": { "./artifacts": "./dist/artifacts" }
	 * modules: ['@my-org/contracts/artifacts']
	 * ```
	 */
	modules?: string[];

	/**
	 * Function that resolves and returns artifacts dynamically
	 * Useful for loading from APIs, databases, or complex logic
	 */
	resolver?: ArtifactResolver;

	/**
	 * Solc version to use when creating synthetic compilations
	 * @default "0.8.20"
	 */
	solcVersion?: string;

	/**
	 * Whether to log warnings for malformed artifacts
	 * @default true
	 */
	warnOnInvalidArtifacts?: boolean;

	/**
	 * Enable debug logging to diagnose issues
	 * @default false
	 */
	debug?: boolean;
}
