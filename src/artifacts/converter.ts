import type {ExternalArtifact, RichArtifact, LinkReferences} from './types.js';
import {isRichArtifact} from './types.js';

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
 * Convert artifacts to compilation format.
 * If artifacts are "rich" (have solcInput), use the embedded data.
 * Otherwise, synthesize a minimal compilation.
 */
export function artifactsToCompilations(
	artifacts: ExternalArtifact[],
	defaultSolcVersion: string,
	debug: boolean = false,
): SyntheticCompilation[] {
	// Group artifacts by whether they have solcInput
	const richArtifacts = artifacts.filter(isRichArtifact);
	const simpleArtifacts = artifacts.filter((a) => !isRichArtifact(a));

	if (debug) {
		console.log(`[external-artifacts] Processing ${artifacts.length} artifacts:`);
		console.log(`  - Rich artifacts (with solcInput): ${richArtifacts.length}`);
		console.log(`  - Simple artifacts: ${simpleArtifacts.length}`);
		for (const artifact of artifacts) {
			const isRich = isRichArtifact(artifact);
			const richArt = artifact as Partial<RichArtifact>;
			const immRefs = richArt.evm?.deployedBytecode?.immutableReferences ?? artifact.immutableReferences;
			const immCount = immRefs ? Object.keys(immRefs).length : 0;
			console.log(`  - ${artifact.contractName}: ${isRich ? 'rich' : 'simple'}, immutableReferences: ${immCount} keys`);
		}
	}

	const compilations: SyntheticCompilation[] = [];

	// Process rich artifacts - these have embedded solcInput
	for (const artifact of richArtifacts) {
		const compilation = richArtifactToCompilation(artifact, debug);
		if (compilation) {
			compilations.push(compilation);
		}
	}

	// Process simple artifacts - synthesize compilation
	if (simpleArtifacts.length > 0) {
		compilations.push(
			synthesizeCompilation(simpleArtifacts, defaultSolcVersion, debug),
		);
	}

	return compilations;
}

/**
 * Convert a rich artifact (with embedded solcInput) to a compilation.
 * Uses the embedded solcInput directly for maximum fidelity.
 */
function richArtifactToCompilation(
	artifact: RichArtifact,
	debug: boolean = false,
): SyntheticCompilation | null {
	if (!artifact.solcInput) {
		return null;
	}

	// Parse the embedded solcInput
	const compilerInput: CompilerInput = JSON.parse(artifact.solcInput);

	// Extract solc version from metadata
	let solcVersion = '0.8.20'; // Default
	if (artifact.metadata) {
		try {
			const metadata = JSON.parse(artifact.metadata);
			if (metadata.compiler?.version) {
				// Format: "0.8.10+commit.fc410830" -> extract "0.8.10"
				solcVersion = metadata.compiler.version.split('+')[0];
			}
		} catch {
			// Ignore parsing errors, use default
		}
	}

	// Build compiler output from the artifact
	// Only include sources that we have contract data for
	// Including empty sources/contracts can cause EDR selector fixup issues
	const compilerOutput: CompilerOutput = {
		sources: {},
		contracts: {},
	};

	const sourceName = artifact.sourceName;

	// Track source IDs for all input sources (needed for consistent source indexing)
	let sourceId = 0;
	const sourceIds: Record<string, number> = {};
	for (const srcName of Object.keys(compilerInput.sources)) {
		sourceIds[srcName] = sourceId++;
	}

	// Only include the source that contains our contract
	const contractSourceId = sourceIds[sourceName] ?? sourceId++;
	const contractNodeId = contractSourceId + 1000; // Use an offset to avoid ID conflicts

	compilerOutput.sources[sourceName] = {
		id: contractSourceId,
		ast: createMinimalAst(sourceName, contractSourceId, [
			{name: artifact.contractName, nodeId: contractNodeId},
		]),
	};
	compilerOutput.contracts[sourceName] = {};

	// Ensure the source is in compilerInput as well
	if (!compilerInput.sources[sourceName]) {
		compilerInput.sources[sourceName] = {content: ''};
	}

	// Build bytecode output, ensuring proper format
	// Standard solc output has bytecode.object without 0x prefix
	const bytecode: BytecodeOutput = {
		object: stripHexPrefix(
			artifact.evm?.bytecode?.object ?? artifact.bytecode ?? '0x',
		),
		opcodes: artifact.evm?.bytecode?.opcodes ?? '',
		sourceMap: artifact.evm?.bytecode?.sourceMap ?? '',
		linkReferences:
			artifact.evm?.bytecode?.linkReferences ?? artifact.linkReferences ?? {},
		generatedSources: artifact.evm?.bytecode?.generatedSources,
		functionDebugData: artifact.evm?.bytecode?.functionDebugData,
	};

	const deployedBytecode: BytecodeOutput = {
		object: stripHexPrefix(
			artifact.evm?.deployedBytecode?.object ??
				artifact.deployedBytecode ??
				'0x',
		),
		opcodes: artifact.evm?.deployedBytecode?.opcodes ?? '',
		sourceMap: artifact.evm?.deployedBytecode?.sourceMap ?? '',
		linkReferences:
			artifact.evm?.deployedBytecode?.linkReferences ??
			artifact.deployedLinkReferences ??
			{},
		immutableReferences:
			artifact.evm?.deployedBytecode?.immutableReferences ??
			artifact.immutableReferences ??
			{},
		generatedSources: artifact.evm?.deployedBytecode?.generatedSources,
		functionDebugData: artifact.evm?.deployedBytecode?.functionDebugData,
	};

	// IMPORTANT: Do NOT provide method identifiers - let EDR compute them
	// EDR has internal "selector fixup" logic for function overloading that can fail
	// if we provide method identifiers that it then tries to reconcile with AST info.
	// The error "Failed to fix up the selector for ... #supportsInterface" happens
	// when EDR can't match provided selectors with overloaded functions.
	// By providing an empty object, EDR will compute selectors from the ABI directly.
	const methodIdentifiers: Record<string, string> = {};

	compilerOutput.contracts[sourceName][artifact.contractName] = {
		abi: artifact.abi,
		evm: {
			bytecode,
			deployedBytecode,
			methodIdentifiers,
		},
		metadata: artifact.metadata,
		devdoc: artifact.devdoc,
		userdoc: artifact.userdoc,
		storageLayout: artifact.storageLayout,
	};

	if (debug) {
		const immRefKeys = Object.keys(deployedBytecode.immutableReferences ?? {});
		console.log(`[external-artifacts] Rich artifact: ${artifact.contractName}`);
		console.log(`  - sourceName: ${sourceName}`);
		console.log(`  - solcVersion: ${solcVersion}`);
		console.log(`  - immutableReferences keys: ${immRefKeys.length}`);
		if (immRefKeys.length > 0) {
			console.log(`  - immutableReferences sample:`, JSON.stringify(deployedBytecode.immutableReferences, null, 2).slice(0, 500));
		}
		console.log(`  - deployedBytecode length: ${deployedBytecode.object.length / 2} bytes`);
	}

	return {
		solcVersion,
		compilerInput,
		compilerOutput,
	};
}

/**
 * Synthesize a minimal compilation from simple artifacts.
 * Used when artifacts don't have embedded solcInput.
 */
function synthesizeCompilation(
	artifacts: ExternalArtifact[],
	solcVersion: string,
	debug: boolean = false,
): SyntheticCompilation {
	const sources: CompilerInput['sources'] = {};
	const outputSources: CompilerOutput['sources'] = {};
	const contracts: CompilerOutput['contracts'] = {};

	// First, group artifacts by source
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

	// Track IDs for AST nodes
	let nextId = 0;

	// Create sources with contract definitions in AST
	for (const [sourceName, sourceContracts] of Object.entries(
		contractsBySource,
	)) {
		const sourceId = nextId++;
		sources[sourceName] = {content: ''};
		contracts[sourceName] = {};

		// Create contract nodes for AST
		const contractNodes: Array<{name: string; nodeId: number}> = [];
		for (const {name} of sourceContracts) {
			const nodeId = nextId++;
			contractNodes.push({name, nodeId});
		}

		outputSources[sourceName] = {
			id: sourceId,
			ast: createMinimalAst(sourceName, sourceId, contractNodes),
		};

		// Add contract outputs
		for (const {name, artifact} of sourceContracts) {
			// Cast to access optional evm property that may exist on artifacts
			// without solcInput (partial RichArtifact)
			const richArtifact = artifact as Partial<RichArtifact>;

			const immutableReferences =
				richArtifact.evm?.deployedBytecode?.immutableReferences ??
				artifact.immutableReferences ??
				{};

			contracts[sourceName][name] = {
				abi: artifact.abi,
				evm: {
					bytecode: {
						object: stripHexPrefix(artifact.bytecode),
						opcodes: '',
						sourceMap: '',
						linkReferences: artifact.linkReferences ?? {},
					},
					deployedBytecode: {
						object: stripHexPrefix(artifact.deployedBytecode),
						opcodes: '',
						sourceMap: '',
						linkReferences: artifact.deployedLinkReferences ?? {},
						// Check both evm.deployedBytecode.immutableReferences and top-level
						immutableReferences,
					},
					// Empty object - let EDR compute selectors to avoid selector fixup issues
					// with overloaded functions (consistent with richArtifactToCompilation)
					methodIdentifiers: {},
				},
			};

			if (debug) {
				const immRefKeys = Object.keys(immutableReferences);
				console.log(`[external-artifacts] Simple artifact: ${name}`);
				console.log(`  - sourceName: ${sourceName}`);
				console.log(`  - immutableReferences keys: ${immRefKeys.length}`);
				if (immRefKeys.length > 0) {
					console.log(`  - immutableReferences sample:`, JSON.stringify(immutableReferences, null, 2).slice(0, 500));
				}
				console.log(`  - deployedBytecode length: ${artifact.deployedBytecode.length / 2} bytes`);
			}
		}
	}

	return {
		solcVersion,
		compilerInput: {
			language: 'Solidity',
			sources,
			settings: {
				optimizer: {enabled: false},
				outputSelection: {
					'*': {'*': ['abi', 'evm.bytecode', 'evm.deployedBytecode']},
				},
			},
		},
		compilerOutput: {
			sources: outputSources,
			contracts,
		},
	};
}

function stripHexPrefix(hex: string): string {
	return hex.startsWith('0x') ? hex.slice(2) : hex;
}
