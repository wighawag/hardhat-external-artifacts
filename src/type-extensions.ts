import 'hardhat/types/config';
import type {ExternalArtifactsConfig} from './artifacts/types.js';

declare module 'hardhat/types/config' {
	interface HardhatUserConfig {
		externalArtifacts?: ExternalArtifactsConfig;
	}

	interface HardhatConfig {
		externalArtifacts: Required<Omit<ExternalArtifactsConfig, 'resolver'>> & {
			resolver?: ExternalArtifactsConfig['resolver'];
		};
	}
}
