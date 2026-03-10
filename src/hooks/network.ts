import type { NetworkHooks, HookContext } from "hardhat/types/hooks";
import type { NetworkConnection, ChainType } from "hardhat/types/network";
import { ArtifactLoader } from "../artifacts/loader.js";
import { artifactsToCompilations } from "../artifacts/converter.js";

export default async (): Promise<Partial<NetworkHooks>> => {
  const handlers: Partial<NetworkHooks> = {
    newConnection: async <ChainTypeT extends ChainType | string>(
      context: HookContext,
      next: (nextContext: HookContext) => Promise<NetworkConnection<ChainTypeT>>,
    ): Promise<NetworkConnection<ChainTypeT>> => {
      // Call the default behavior first to create the connection
      const connection = await next(context);

      // Only inject artifacts for EDR networks (hardhat network)
      if (connection.networkConfig.type !== "edr-simulated") {
        return connection;
      }

      const config = context.config.externalArtifacts;

      // Check if there's anything to load
      if (!config.paths?.length && !config.resolver) {
        return connection;
      }

      try {
        // Load external artifacts
        const loader = new ArtifactLoader(config, context.config.paths.root);
        const artifacts = await loader.loadAll();

        if (artifacts.length === 0) {
          return connection;
        }

        // Convert to compilation format(s)
        // Rich artifacts with solcInput get their own compilations
        // Simple artifacts get grouped into a synthetic compilation
        const compilations = artifactsToCompilations(artifacts, config.solcVersion);

        // Add to the EDR provider - use type assertion since addCompilationResult is an internal method
        const provider = connection.provider as {
          addCompilationResult?: (solcVersion: string, compilerInput: any, compilerOutput: any) => Promise<boolean>;
        };

        if (typeof provider.addCompilationResult === "function") {
          for (const compilation of compilations) {
            await provider.addCompilationResult(
              compilation.solcVersion,
              compilation.compilerInput,
              compilation.compilerOutput,
            );
          }

          console.log(
            `[hardhat-external-artifacts] Loaded ${artifacts.length} external artifact(s) in ${compilations.length} compilation(s)`,
          );
        }
      } catch (error) {
        if (config.warnOnInvalidArtifacts) {
          console.warn(`[hardhat-external-artifacts] Warning: Failed to load external artifacts:`, error);
        }
      }

      return connection;
    },
  };

  return handlers;
};
