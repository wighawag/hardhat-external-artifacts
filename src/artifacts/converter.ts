import type {ExternalArtifact, RichArtifact, LinkReferences} from './types.js';
import {hasSolcInput, hasMetadata, hasEvmData} from './types.js';

export interface SyntheticCompilation {
	solcVersion: string;
	compilerInput: CompilerInput;
	compilerOutput: CompilerOutput;
}

interface CompilerInput {
	language: string;
	sources: Record<string, {content: string}>;
	settings: {
		optimizer: {enabled: boolean; runs?: number};
		outputSelection: Record<string, Record<string, string[]>>;
		remappings?: string[];
		metadata?: {useLiteralContent?: boolean; bytecodeHash?: string};
		evmVersion?: string;
		viaIR?: boolean;
	};
}

interface CompilerOutput {
	sources: Record<string, {id: number; ast: object}>;
	contracts: Record<
		string,
		Record<
			string,
			{
				abi: readonly any[];
				evm: {
					bytecode: BytecodeOutput;
					deployedBytecode: BytecodeOutput;
					methodIdentifiers: Record<string, string>;
				};
				metadata?: string;
				devdoc?: any;
				userdoc?: any;
				storageLayout?: any;
			}
		>
	>;
}

interface BytecodeOutput {
	object: string;
	opcodes: string;
	sourceMap: string;
	linkReferences: LinkReferences;
	immutableReferences?: Record<string, Array<{start: number; length: number}>>;
	generatedSources?: any[];
	functionDebugData?: Record<string, any>;
}

/**
 * Extracted compilation context from an artifact.
 * Used to group artifacts that share the same compilation settings.
 */
interface CompilationContext {
	solcVersion: string;
	compilerInput: CompilerInput | null;
	/** Key for grouping artifacts with same compilation context */
	groupKey: string;
}

/**
 * Creates a minimal valid AST for a source file.
 * This is needed because Hardhat's contract decoder expects a valid AST structure.
 */
function createMinimalAst(
	sourceName: string,
	sourceId: number,
	contracts?: Array<{name: string; nodeId: number}>,
): object {
	const nodes: object[] = [];
	const exportedSymbols: Record<string, number[]> = {};

	// Add contract definition nodes if provided
	if (contracts) {
		for (const contract of contracts) {
			nodes.push({
				nodeType: 'ContractDefinition',
				id: contract.nodeId,
				src: `0:0:${sourceId}`,
				name: contract.name,
				contractKind: 'contract',
				abstract: false,
				fullyImplemented: true,
				linearizedBaseContracts: [contract.nodeId],
				nodes: [],
				scope: sourceId,
			});
			exportedSymbols[contract.name] = [contract.nodeId];
		}
	}

	return {
		nodeType: 'SourceUnit',
		src: `0:0:${sourceId}`,
		id: sourceId,
		absolutePath: sourceName,
		exportedSymbols,
		nodes,
	};
}

/**
 * Extract compilation context from an artifact.
 * Tries solcInput first, then falls back to metadata, then defaults.
 */
function extractCompilationContext(
	artifact: ExternalArtifact,
	defaultSolcVersion: string,
	debug: boolean = false,
): CompilationContext {
	// Try to extract from solcInput first (most complete)
	if (hasSolcInput(artifact)) {
		try {
			const compilerInput: CompilerInput = JSON.parse(artifact.solcInput);
			const solcVersion = extractVersionFromMetadata(artifact.metadata) ?? defaultSolcVersion;
			// Use a hash of settings to group artifacts with same compilation context
			const settingsKey = JSON.stringify(compilerInput.settings);
			return {
				solcVersion,
				compilerInput,
				groupKey: `solcInput:${solcVersion}:${hashString(settingsKey)}`,
			};
		} catch (e) {
			if (debug) {
				console.log(`[external-artifacts] Failed to parse solcInput for ${artifact.contractName}: ${e}`);
			}
			// Fall through to metadata extraction
		}
	}

	// Try to extract from metadata (partial but useful)
	if (hasMetadata(artifact)) {
		try {
			const metadata = JSON.parse(artifact.metadata);
			const solcVersion = extractVersionFromMetadataObject(metadata) ?? defaultSolcVersion;
			const compilerInput = metadataToCompilerInput(metadata);
			if (compilerInput) {
				const settingsKey = JSON.stringify(compilerInput.settings);
				return {
					solcVersion,
					compilerInput,
					groupKey: `metadata:${solcVersion}:${hashString(settingsKey)}`,
				};
			}
		} catch (e) {
			if (debug) {
				console.log(`[external-artifacts] Failed to parse metadata for ${artifact.contractName}: ${e}`);
			}
			// Fall through to defaults
		}
	}

	// Default: no compiler input available, use defaults
	return {
		solcVersion: defaultSolcVersion,
		compilerInput: null,
		groupKey: `default:${defaultSolcVersion}`,
	};
}

/**
 * Extract solc version from metadata string.
 */
function extractVersionFromMetadata(metadataStr?: string): string | null {
	if (!metadataStr) return null;
	try {
		const metadata = JSON.parse(metadataStr);
		return extractVersionFromMetadataObject(metadata);
	} catch {
		return null;
	}
}

/**
 * Extract solc version from parsed metadata object.
 */
function extractVersionFromMetadataObject(metadata: any): string | null {
	if (metadata?.compiler?.version) {
		// Format: "0.8.10+commit.fc410830" -> extract "0.8.10"
		return metadata.compiler.version.split('+')[0];
	}
	return null;
}

/**
 * Convert metadata to compiler input.
 * Metadata contains settings but not full source content.
 */
function metadataToCompilerInput(metadata: any): CompilerInput | null {
	if (!metadata?.settings) return null;

	const settings = metadata.settings;
	const sources: Record<string, {content: string}> = {};

	// Metadata has source hashes but not content
	// We'll add empty placeholders that get filled in later
	if (metadata.sources) {
		for (const sourceName of Object.keys(metadata.sources)) {
			// Some metadata includes content in keccak256 only
			// We use empty content as placeholder
			sources[sourceName] = {content: ''};
		}
	}

	return {
		language: metadata.language ?? 'Solidity',
		sources,
		settings: {
			optimizer: settings.optimizer ?? {enabled: false},
			outputSelection: settings.outputSelection ?? {
				'*': {'*': ['abi', 'evm.bytecode', 'evm.deployedBytecode']},
			},
			remappings: settings.remappings,
			metadata: settings.metadata,
			evmVersion: settings.evmVersion,
			viaIR: settings.viaIR,
		},
	};
}

/**
 * Simple string hash for grouping.
 */
function hashString(str: string): string {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		const char = str.charCodeAt(i);
		hash = ((hash << 5) - hash) + char;
		hash = hash & hash; // Convert to 32-bit integer
	}
	return hash.toString(16);
}

/**
 * Convert artifacts to compilation format.
 * Flexibly extracts data from each artifact - uses solcInput if available,
 * falls back to metadata for settings, or synthesizes minimal compilation.
 */
export function artifactsToCompilations(
	artifacts: ExternalArtifact[],
	defaultSolcVersion: string,
	debug: boolean = false,
): SyntheticCompilation[] {
	if (debug) {
		console.log(`[external-artifacts] Processing ${artifacts.length} artifacts`);
	}

	// Extract context from each artifact and group by compilation context
	const artifactsByContext: Map<string, {
		context: CompilationContext;
		artifacts: ExternalArtifact[];
	}> = new Map();

	for (const artifact of artifacts) {
		const context = extractCompilationContext(artifact, defaultSolcVersion, debug);
		const richArt = artifact as Partial<RichArtifact>;
		const immRefs = richArt.evm?.deployedBytecode?.immutableReferences ?? artifact.immutableReferences;
		const immCount = immRefs ? Object.keys(immRefs).length : 0;

		if (debug) {
			console.log(`  - ${artifact.contractName}: solcInput=${hasSolcInput(artifact)}, metadata=${hasMetadata(artifact)}, immutableReferences=${immCount} keys, group=${context.groupKey}`);
		}

		const existing = artifactsByContext.get(context.groupKey);
		if (existing) {
			existing.artifacts.push(artifact);
		} else {
			artifactsByContext.set(context.groupKey, {
				context,
				artifacts: [artifact],
			});
		}
	}

	if (debug) {
		console.log(`[external-artifacts] Grouped into ${artifactsByContext.size} compilations`);
	}

	// Convert each group to a compilation
	const compilations: SyntheticCompilation[] = [];

	for (const {context, artifacts: groupArtifacts} of artifactsByContext.values()) {
		const compilation = buildCompilation(groupArtifacts, context, debug);
		compilations.push(compilation);
	}

	return compilations;
}

/**
 * Build a compilation from a group of artifacts sharing the same context.
 * Flexibly extracts available data from each artifact.
 */
function buildCompilation(
	artifacts: ExternalArtifact[],
	context: CompilationContext,
	debug: boolean = false,
): SyntheticCompilation {
	// Start with context's compiler input or create a minimal one
	const compilerInput: CompilerInput = context.compilerInput
		? {...context.compilerInput, sources: {...context.compilerInput.sources}}
		: {
			language: 'Solidity',
			sources: {},
			settings: {
				optimizer: {enabled: false},
				outputSelection: {
					'*': {'*': ['abi', 'evm.bytecode', 'evm.deployedBytecode']},
				},
			},
		};

	const compilerOutput: CompilerOutput = {
		sources: {},
		contracts: {},
	};

	// Group artifacts by source for AST generation
	const contractsBySource: Record<
		string,
		Array<{name: string; artifact: ExternalArtifact}>
	> = {};
	for (const artifact of artifacts) {
		if (!contractsBySource[artifact.sourceName]) {
			contractsBySource[artifact.sourceName] = [];
		}
		contractsBySource[artifact.sourceName].push({
			name: artifact.contractName,
			artifact,
		});
	}

	// Track source IDs - use existing ones from compiler input if available
	let nextSourceId = 0;
	const sourceIds: Record<string, number> = {};
	for (const srcName of Object.keys(compilerInput.sources)) {
		sourceIds[srcName] = nextSourceId++;
	}

	// Track node IDs for AST
	let nextNodeId = nextSourceId + 1000; // Offset to avoid conflicts

	// Process each source
	for (const [sourceName, sourceContracts] of Object.entries(contractsBySource)) {
		// Ensure source exists in compiler input
		if (!compilerInput.sources[sourceName]) {
			compilerInput.sources[sourceName] = {content: ''};
		}

		// Get or assign source ID
		const sourceId = sourceIds[sourceName] ?? nextSourceId++;
		sourceIds[sourceName] = sourceId;

		// Create contract nodes for AST
		const contractNodes: Array<{name: string; nodeId: number}> = [];
		for (const {name} of sourceContracts) {
			contractNodes.push({name, nodeId: nextNodeId++});
		}

		compilerOutput.sources[sourceName] = {
			id: sourceId,
			ast: createMinimalAst(sourceName, sourceId, contractNodes),
		};

		compilerOutput.contracts[sourceName] = {};

		// Add contract outputs
		for (const {name, artifact} of sourceContracts) {
			const richArtifact = artifact as Partial<RichArtifact>;

			// Build bytecode output, extracting from evm if available
			const bytecode: BytecodeOutput = {
				object: stripHexPrefix(
					richArtifact.evm?.bytecode?.object ?? artifact.bytecode ?? '0x',
				),
				opcodes: richArtifact.evm?.bytecode?.opcodes ?? '',
				sourceMap: richArtifact.evm?.bytecode?.sourceMap ?? '',
				linkReferences:
					richArtifact.evm?.bytecode?.linkReferences ?? artifact.linkReferences ?? {},
				generatedSources: richArtifact.evm?.bytecode?.generatedSources,
				functionDebugData: richArtifact.evm?.bytecode?.functionDebugData,
			};

			const immutableReferences =
				richArtifact.evm?.deployedBytecode?.immutableReferences ??
				artifact.immutableReferences ??
				{};

			const deployedBytecode: BytecodeOutput = {
				object: stripHexPrefix(
					richArtifact.evm?.deployedBytecode?.object ??
						artifact.deployedBytecode ??
						'0x',
				),
				opcodes: richArtifact.evm?.deployedBytecode?.opcodes ?? '',
				sourceMap: richArtifact.evm?.deployedBytecode?.sourceMap ?? '',
				linkReferences:
					richArtifact.evm?.deployedBytecode?.linkReferences ??
					artifact.deployedLinkReferences ??
					{},
				immutableReferences,
				generatedSources: richArtifact.evm?.deployedBytecode?.generatedSources,
				functionDebugData: richArtifact.evm?.deployedBytecode?.functionDebugData,
			};

			// IMPORTANT: Do NOT provide method identifiers - let EDR compute them
			// EDR has internal "selector fixup" logic for function overloading that can fail
			// if we provide method identifiers that it then tries to reconcile with AST info.
			compilerOutput.contracts[sourceName][name] = {
				abi: artifact.abi,
				evm: {
					bytecode,
					deployedBytecode,
					methodIdentifiers: {},
				},
				metadata: richArtifact.metadata,
				devdoc: richArtifact.devdoc,
				userdoc: richArtifact.userdoc,
				storageLayout: richArtifact.storageLayout,
			};

			if (debug) {
				const immRefKeys = Object.keys(immutableReferences);
				console.log(`[external-artifacts] Built artifact: ${name}`);
				console.log(`  - sourceName: ${sourceName}`);
					console.log(`  - hasSolcInput: ${hasSolcInput(artifact)}`);
					console.log(`  - hasMetadata: ${hasMetadata(artifact)}`);
					console.log(`  - hasEvmData: ${hasEvmData(artifact)}`);
				console.log(`  - immutableReferences keys: ${immRefKeys.length}`);
				if (immRefKeys.length > 0) {
					console.log(`  - immutableReferences sample:`, JSON.stringify(immutableReferences, null, 2).slice(0, 500));
				}
				console.log(`  - deployedBytecode length: ${deployedBytecode.object.length / 2} bytes`);
			}
		}
	}

	return {
		solcVersion: context.solcVersion,
		compilerInput,
		compilerOutput,
	};
}

function stripHexPrefix(hex: string): string {
	return hex.startsWith('0x') ? hex.slice(2) : hex;
}
