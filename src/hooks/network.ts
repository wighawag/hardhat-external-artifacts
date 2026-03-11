import type {NetworkHooks, HookContext} from 'hardhat/types/hooks';
import type {NetworkConnection, ChainType} from 'hardhat/types/network';
import {ArtifactLoader} from '../artifacts/loader.js';
import {
	artifactsToCompilations,
	type SyntheticCompilation,
} from '../artifacts/converter.js';
import {hasSolcInput} from '../artifacts/types.js';

export default async (): Promise<Partial<NetworkHooks>> => {
	const handlers: Partial<NetworkHooks> = {
		newConnection: async <ChainTypeT extends ChainType | string>(
			context: HookContext,
			next: (
				nextContext: HookContext,
			) => Promise<NetworkConnection<ChainTypeT>>,
		): Promise<NetworkConnection<ChainTypeT>> => {
			// Call the default behavior first to create the connection
			const connection = await next(context);

			// Only inject artifacts for EDR networks (hardhat network)
			if (connection.networkConfig.type !== 'edr-simulated') {
				return connection;
			}

			const config = context.config.externalArtifacts;

			// Check if config exists and there's anything to load
			if (
				!config ||
				(!config.modules?.length && !config.paths?.length && !config.resolver)
			) {
				return connection;
			}

			const debug = config.debug ?? false;
			const log = debug ? console.log.bind(console) : () => {};

			try {
				// Load external artifacts
				const loader = new ArtifactLoader(config, context.config.paths.root);
				const artifacts = await loader.loadAll();

				if (artifacts.length === 0) {
					log('[hardhat-external-artifacts] No artifacts found');
					return connection;
				}

				log(
					`[hardhat-external-artifacts] Loaded ${artifacts.length} artifact(s):`,
				);
				for (const artifact of artifacts) {
					const hasSolc = hasSolcInput(artifact);
					const deployedBytecodeLength = artifact.deployedBytecode?.length || 0;
					log(
						`  - ${artifact.sourceName}:${artifact.contractName} (${hasSolc ? 'with solcInput' : 'minimal'}, deployedBytecode: ${deployedBytecodeLength} chars)`,
					);
				}

				// Convert to compilation format(s)
				// Rich artifacts with solcInput get their own compilations
				// Simple artifacts get grouped into a synthetic compilation
				const compilations = artifactsToCompilations(
					artifacts,
					config.solcVersion, // Default already set in config.ts
					debug,
				);

				log(
					`[hardhat-external-artifacts] Created ${compilations.length} compilation(s)`,
				);

				// Add to the EDR provider - use type assertion since addCompilationResult is an internal method
				const provider = connection.provider as {
					addCompilationResult?: (
						solcVersion: string,
						compilerInput: any,
						compilerOutput: any,
					) => Promise<void>;
				};

				if (typeof provider.addCompilationResult === 'function') {
					for (const compilation of compilations) {
						logCompilation(compilation, log);

						// Ensure clean JSON serialization for the native EDR binding
						// by round-tripping through JSON stringify/parse
						const cleanInput = JSON.parse(
							JSON.stringify(compilation.compilerInput),
						);
						const cleanOutput = JSON.parse(
							JSON.stringify(compilation.compilerOutput),
						);

						log(
							`[hardhat-external-artifacts] Calling addCompilationResult with solcVersion: ${compilation.solcVersion}`,
						);

						await provider.addCompilationResult(
							compilation.solcVersion,
							cleanInput,
							cleanOutput,
						);
						log(
							`[hardhat-external-artifacts] Successfully added compilation to EDR provider`,
						);
					}

					console.log(
						`[hardhat-external-artifacts] Loaded ${artifacts.length} external artifact(s) in ${compilations.length} compilation(s)`,
					);
				} else {
					console.warn(
						`[hardhat-external-artifacts] Warning: provider.addCompilationResult is not available. ` +
							`This might indicate an incompatible Hardhat version.`,
					);
				}
			} catch (error) {
				if (config.warnOnInvalidArtifacts !== false) {
					console.warn(
						`[hardhat-external-artifacts] Warning: Failed to load external artifacts:`,
						error,
					);
				}
			}

			return connection;
		},
	};

	return handlers;
};

function logCompilation(
	compilation: SyntheticCompilation,
	log: (...args: any[]) => void,
): void {
	log(`[hardhat-external-artifacts] Compilation details:`);
	log(`  solcVersion: ${compilation.solcVersion}`);
	log(
		`  sources in compilerInput: ${Object.keys(compilation.compilerInput.sources).join(', ')}`,
	);
	log(
		`  sources in compilerOutput: ${Object.keys(compilation.compilerOutput.sources).join(', ')}`,
	);

	for (const [sourceName, contracts] of Object.entries(
		compilation.compilerOutput.contracts || {},
	)) {
		for (const [contractName, contract] of Object.entries(
			contracts as Record<string, any>,
		)) {
			const deployedBytecodeLength =
				contract.evm?.deployedBytecode?.object?.length || 0;
			const methodCount = Object.keys(
				contract.evm?.methodIdentifiers || {},
			).length;
			const immutableRefs = contract.evm?.deployedBytecode?.immutableReferences || {};
			const immutableCount = Object.keys(immutableRefs).length;
			log(
				`  ${sourceName}:${contractName} - deployedBytecode: ${deployedBytecodeLength} chars (${Math.floor(deployedBytecodeLength / 2)} bytes), methods: ${methodCount}, immutableRefs: ${immutableCount}`,
			);
			// Log immutable references details
			if (immutableCount > 0) {
				log(`    immutableReferences keys: ${Object.keys(immutableRefs).join(', ')}`);
				// Show first few references
				const sample = Object.entries(immutableRefs).slice(0, 3);
				for (const [id, refs] of sample) {
					log(`      ${id}: ${JSON.stringify(refs)}`);
				}
				if (immutableCount > 3) {
					log(`      ... and ${immutableCount - 3} more`);
				}
			}
			// Log first 100 chars of bytecode for verification
			if (deployedBytecodeLength > 0) {
				const preview = contract.evm.deployedBytecode.object.substring(0, 100);
				log(`    bytecode preview: ${preview}...`);
			}
		}
	}
}
