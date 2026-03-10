import type {ConfigHooks} from 'hardhat/types/hooks';
import type {ExternalArtifactsConfig} from '../artifacts/types.js';

export default async (): Promise<Partial<ConfigHooks>> => {
	const handlers: Partial<ConfigHooks> = {
		resolveUserConfig: async (
			userConfig,
			resolveConfigurationVariable,
			next,
		) => {
			const resolvedConfig = await next(
				userConfig,
				resolveConfigurationVariable,
			);

			// Get user's external artifacts config
			const externalArtifactsUserConfig = userConfig.externalArtifacts as
				| ExternalArtifactsConfig
				| undefined;

			// Apply defaults
			const externalArtifacts: Required<
				Omit<ExternalArtifactsConfig, 'resolver'>
			> & {
				resolver?: ExternalArtifactsConfig['resolver'];
			} = {
				paths: externalArtifactsUserConfig?.paths ?? [],
				resolver: externalArtifactsUserConfig?.resolver,
				solcVersion: externalArtifactsUserConfig?.solcVersion ?? '0.8.20',
				warnOnInvalidArtifacts:
					externalArtifactsUserConfig?.warnOnInvalidArtifacts ?? true,
				debug: externalArtifactsUserConfig?.debug ?? false,
			};

			return {
				...resolvedConfig,
				externalArtifacts,
			};
		},
	};

	return handlers;
};
