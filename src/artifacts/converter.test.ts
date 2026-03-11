import {describe, it, expect} from 'vitest';
import {artifactsToCompilations} from './converter.js';
import type {ExternalArtifact, RichArtifact} from './types.js';
import {hasSolcInput, hasMetadata, hasEvmData} from './types.js';

// Helper to create a minimal artifact
function createMinimalArtifact(
	name: string,
	sourceName: string = `contracts/${name}.sol`,
): ExternalArtifact {
	return {
		contractName: name,
		sourceName,
		abi: [{type: 'function', name: 'test', inputs: [], outputs: []}],
		bytecode: '0x608060405234801561001057600080fd5b50',
		deployedBytecode: '0x608060405234801561001057600080fd5b50',
	};
}

// Helper to create a rich artifact with solcInput
function createRichArtifactWithSolcInput(
	name: string,
	sourceName: string = `contracts/${name}.sol`,
): RichArtifact {
	const solcInput = JSON.stringify({
		language: 'Solidity',
		sources: {[sourceName]: {content: `contract ${name} {}`}},
		settings: {
			optimizer: {enabled: true, runs: 200},
			outputSelection: {'*': {'*': ['abi', 'evm.bytecode']}},
		},
	});

	const metadata = JSON.stringify({
		compiler: {version: '0.8.20+commit.a1b79de6'},
		language: 'Solidity',
		settings: {
			optimizer: {enabled: true, runs: 200},
		},
	});

	return {
		...createMinimalArtifact(name, sourceName),
		solcInput,
		metadata,
	};
}

// Helper to create an artifact with only metadata (no solcInput)
function createArtifactWithMetadata(
	name: string,
	sourceName: string = `contracts/${name}.sol`,
): RichArtifact {
	const metadata = JSON.stringify({
		compiler: {version: '0.8.19+commit.7dd6d404'},
		language: 'Solidity',
		settings: {
			optimizer: {enabled: false},
			evmVersion: 'paris',
		},
		sources: {[sourceName]: {keccak256: '0x1234'}},
	});

	return {
		...createMinimalArtifact(name, sourceName),
		metadata,
	};
}

// Helper to create an artifact with EVM data
function createArtifactWithEvmData(
	name: string,
	sourceName: string = `contracts/${name}.sol`,
): RichArtifact {
	return {
		...createMinimalArtifact(name, sourceName),
		evm: {
			bytecode: {
				object: '608060405234801561001057600080fd5b50',
				opcodes: 'PUSH1 0x80 PUSH1 0x40 MSTORE',
				sourceMap: '1:100:0:-:0;',
				linkReferences: {},
				generatedSources: [],
			},
			deployedBytecode: {
				object: '608060405234801561001057600080fd5b50',
				opcodes: 'PUSH1 0x80 PUSH1 0x40 MSTORE',
				sourceMap: '1:100:0:-:0;',
				linkReferences: {},
				immutableReferences: {
					'42': [{start: 10, length: 32}],
				},
			},
		},
	};
}

describe('Type Guards', () => {
	describe('hasSolcInput', () => {
		it('returns true for artifacts with solcInput string', () => {
			const artifact = createRichArtifactWithSolcInput('TestContract');
			expect(hasSolcInput(artifact)).toBe(true);
		});

		it('returns false for artifacts without solcInput', () => {
			const artifact = createMinimalArtifact('TestContract');
			expect(hasSolcInput(artifact)).toBe(false);
		});

		it('returns false for artifacts with undefined solcInput', () => {
			const artifact: RichArtifact = {
				...createMinimalArtifact('TestContract'),
				solcInput: undefined,
			};
			expect(hasSolcInput(artifact)).toBe(false);
		});
	});

	describe('hasMetadata', () => {
		it('returns true for artifacts with metadata string', () => {
			const artifact = createArtifactWithMetadata('TestContract');
			expect(hasMetadata(artifact)).toBe(true);
		});

		it('returns false for artifacts without metadata', () => {
			const artifact = createMinimalArtifact('TestContract');
			expect(hasMetadata(artifact)).toBe(false);
		});
	});

	describe('hasEvmData', () => {
		it('returns true for artifacts with EVM data', () => {
			const artifact = createArtifactWithEvmData('TestContract');
			expect(hasEvmData(artifact)).toBe(true);
		});

		it('returns false for artifacts without EVM data', () => {
			const artifact = createMinimalArtifact('TestContract');
			expect(hasEvmData(artifact)).toBe(false);
		});
	});
});

describe('artifactsToCompilations', () => {
	it('processes minimal artifacts using default compilation', () => {
		const artifacts = [
			createMinimalArtifact('Contract1'),
			createMinimalArtifact('Contract2'),
		];

		const compilations = artifactsToCompilations(artifacts, '0.8.20');

		expect(compilations.length).toBe(1);
		expect(compilations[0].solcVersion).toBe('0.8.20');
		expect(Object.keys(compilations[0].compilerOutput.contracts)).toHaveLength(2);
	});

	it('extracts version from metadata when solcInput is available', () => {
		const artifact = createRichArtifactWithSolcInput('TestContract');
		const compilations = artifactsToCompilations([artifact], '0.8.15');

		expect(compilations.length).toBe(1);
		// Should use version from metadata (0.8.20) not default (0.8.15)
		expect(compilations[0].solcVersion).toBe('0.8.20');
	});

	it('uses metadata for compiler settings when solcInput is missing', () => {
		const artifact = createArtifactWithMetadata('TestContract');
		const compilations = artifactsToCompilations([artifact], '0.8.15');

		expect(compilations.length).toBe(1);
		// Should use version from metadata (0.8.19)
		expect(compilations[0].solcVersion).toBe('0.8.19');
		// Should have evmVersion from metadata settings
		expect(compilations[0].compilerInput.settings.evmVersion).toBe('paris');
	});

	it('uses default solcVersion when no metadata is available', () => {
		const artifact = createMinimalArtifact('TestContract');
		const compilations = artifactsToCompilations([artifact], '0.8.15');

		expect(compilations.length).toBe(1);
		expect(compilations[0].solcVersion).toBe('0.8.15');
	});

	it('groups artifacts with same compilation context', () => {
		// Two artifacts with the same solcInput settings should be grouped
		const artifact1 = createRichArtifactWithSolcInput('Contract1');
		const artifact2 = createRichArtifactWithSolcInput('Contract2');

		const compilations = artifactsToCompilations([artifact1, artifact2], '0.8.20');

		expect(compilations.length).toBe(1);
		const sourcesInCompilation = Object.keys(compilations[0].compilerOutput.contracts);
		expect(sourcesInCompilation).toContain('contracts/Contract1.sol');
		expect(sourcesInCompilation).toContain('contracts/Contract2.sol');
	});

	it('separates artifacts with different compilation contexts', () => {
		const richArtifact = createRichArtifactWithSolcInput('RichContract');
		const minimalArtifact = createMinimalArtifact('MinimalContract');

		const compilations = artifactsToCompilations(
			[richArtifact, minimalArtifact],
			'0.8.20',
		);

		// Should have 2 compilations: one for solcInput-based, one for default
		expect(compilations.length).toBe(2);
	});

	it('extracts immutableReferences from evm data', () => {
		const artifact = createArtifactWithEvmData('TestContract');
		const compilations = artifactsToCompilations([artifact], '0.8.20');

		expect(compilations.length).toBe(1);
		const contract =
			compilations[0].compilerOutput.contracts['contracts/TestContract.sol'][
				'TestContract'
			];
		expect(contract.evm.deployedBytecode.immutableReferences).toEqual({
			'42': [{start: 10, length: 32}],
		});
	});

	it('handles artifacts with different source names in same compilation', () => {
		const artifact1 = createMinimalArtifact('Contract1', 'src/Contract1.sol');
		const artifact2 = createMinimalArtifact('Contract2', 'lib/Contract2.sol');

		const compilations = artifactsToCompilations([artifact1, artifact2], '0.8.20');

		expect(compilations.length).toBe(1);
		expect(compilations[0].compilerOutput.contracts['src/Contract1.sol']).toBeDefined();
		expect(compilations[0].compilerOutput.contracts['lib/Contract2.sol']).toBeDefined();
	});

	it('creates valid AST with contract nodes', () => {
		const artifact = createMinimalArtifact('TestContract');
		const compilations = artifactsToCompilations([artifact], '0.8.20');

		const ast = compilations[0].compilerOutput.sources['contracts/TestContract.sol'].ast as any;
		expect(ast.nodeType).toBe('SourceUnit');
		expect(ast.nodes).toHaveLength(1);
		expect(ast.nodes[0].nodeType).toBe('ContractDefinition');
		expect(ast.nodes[0].name).toBe('TestContract');
	});

	it('strips 0x prefix from bytecode', () => {
		const artifact = createMinimalArtifact('TestContract');
		const compilations = artifactsToCompilations([artifact], '0.8.20');

		const contract =
			compilations[0].compilerOutput.contracts['contracts/TestContract.sol'][
				'TestContract'
			];
		expect(contract.evm.bytecode.object).not.toMatch(/^0x/);
		expect(contract.evm.deployedBytecode.object).not.toMatch(/^0x/);
	});

	it('provides empty methodIdentifiers for EDR compatibility', () => {
		const artifact = createMinimalArtifact('TestContract');
		const compilations = artifactsToCompilations([artifact], '0.8.20');

		const contract =
			compilations[0].compilerOutput.contracts['contracts/TestContract.sol'][
				'TestContract'
			];
		expect(contract.evm.methodIdentifiers).toEqual({});
	});

	it('handles malformed solcInput gracefully', () => {
		const artifact: RichArtifact = {
			...createMinimalArtifact('TestContract'),
			solcInput: 'not valid json',
		};

		// Should not throw, should fall back to default compilation
		const compilations = artifactsToCompilations([artifact], '0.8.20');
		expect(compilations.length).toBe(1);
		expect(compilations[0].solcVersion).toBe('0.8.20');
	});

	it('handles malformed metadata gracefully', () => {
		const artifact: RichArtifact = {
			...createMinimalArtifact('TestContract'),
			metadata: 'not valid json',
		};

		// Should not throw, should fall back to default compilation
		const compilations = artifactsToCompilations([artifact], '0.8.20');
		expect(compilations.length).toBe(1);
		expect(compilations[0].solcVersion).toBe('0.8.20');
	});
});
