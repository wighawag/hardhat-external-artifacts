import type {ExternalArtifact, RichArtifact, LinkReferences} from './types.js';
import {isRichArtifact} from './types.js';
import {keccak256, toBytes} from 'viem';

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
 * Convert artifacts to compilation format.
 * If artifacts are "rich" (have solcInput), use the embedded data.
 * Otherwise, synthesize a minimal compilation.
 */
export function artifactsToCompilations(
	artifacts: ExternalArtifact[],
	defaultSolcVersion: string,
): SyntheticCompilation[] {
	// Group artifacts by whether they have solcInput
	const richArtifacts = artifacts.filter(isRichArtifact);
	const simpleArtifacts = artifacts.filter((a) => !isRichArtifact(a));

	const compilations: SyntheticCompilation[] = [];

	// Process rich artifacts - these have embedded solcInput
	for (const artifact of richArtifacts) {
		const compilation = richArtifactToCompilation(artifact);
		if (compilation) {
			compilations.push(compilation);
		}
	}

	// Process simple artifacts - synthesize compilation
	if (simpleArtifacts.length > 0) {
		compilations.push(
			synthesizeCompilation(simpleArtifacts, defaultSolcVersion),
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
	const compilerOutput: CompilerOutput = {
		sources: {},
		contracts: {},
	};

	// Create source entries
	let sourceId = 0;
	for (const sourceName of Object.keys(compilerInput.sources)) {
		compilerOutput.sources[sourceName] = {id: sourceId++, ast: {}};
		compilerOutput.contracts[sourceName] = {};
	}

	// Add the contract
	const sourceName = artifact.sourceName;
	if (!compilerOutput.contracts[sourceName]) {
		compilerOutput.contracts[sourceName] = {};
	}

	compilerOutput.contracts[sourceName][artifact.contractName] = {
		abi: artifact.abi,
		evm: {
			bytecode: artifact.evm?.bytecode ?? {
				object: stripHexPrefix(artifact.bytecode),
				opcodes: '',
				sourceMap: '',
				linkReferences: artifact.linkReferences ?? {},
			},
			deployedBytecode: artifact.evm?.deployedBytecode ?? {
				object: stripHexPrefix(artifact.deployedBytecode),
				opcodes: '',
				sourceMap: '',
				linkReferences: artifact.deployedLinkReferences ?? {},
				immutableReferences: {},
			},
			methodIdentifiers:
				artifact.evm?.methodIdentifiers ??
				computeMethodIdentifiers(artifact.abi),
		},
		metadata: artifact.metadata,
		devdoc: artifact.devdoc,
		userdoc: artifact.userdoc,
		storageLayout: artifact.storageLayout,
	};

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
): SyntheticCompilation {
	const sources: CompilerInput['sources'] = {};
	const outputSources: CompilerOutput['sources'] = {};
	const contracts: CompilerOutput['contracts'] = {};

	let sourceId = 0;

	for (const artifact of artifacts) {
		const sourceName = artifact.sourceName;

		// Add to sources if not already present
		if (!sources[sourceName]) {
			sources[sourceName] = {content: ''};
			outputSources[sourceName] = {id: sourceId++, ast: {}};
			contracts[sourceName] = {};
		}

		// Add contract output
		contracts[sourceName][artifact.contractName] = {
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
					immutableReferences: {},
				},
				methodIdentifiers: computeMethodIdentifiers(artifact.abi),
			},
		};
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

/**
 * Compute function selector from a function signature.
 * Takes the first 4 bytes of keccak256 hash.
 */
function computeSelector(signature: string): string {
	const hash = keccak256(toBytes(signature));
	return hash.slice(2, 10); // Remove "0x" prefix and take first 8 hex chars (4 bytes)
}

/**
 * Get the canonical type for an ABI input/output parameter.
 * Handles tuple types recursively.
 */
function getCanonicalType(param: any): string {
	if (param.type === 'tuple' || param.type === 'tuple[]') {
		const components = param.components || [];
		const tupleTypes = components
			.map((c: any) => getCanonicalType(c))
			.join(',');
		const isArray = param.type.endsWith('[]');
		return `(${tupleTypes})${isArray ? '[]' : ''}`;
	}
	return param.type;
}

/**
 * Compute method identifiers (function selectors) from ABI.
 */
function computeMethodIdentifiers(abi: readonly any[]): Record<string, string> {
	const identifiers: Record<string, string> = {};

	for (const item of abi) {
		if (item.type === 'function') {
			const inputs = item.inputs ?? [];
			const types = inputs.map((i: any) => getCanonicalType(i)).join(',');
			const signature = `${item.name}(${types})`;
			identifiers[signature] = computeSelector(signature);
		}
	}

	return identifiers;
}
