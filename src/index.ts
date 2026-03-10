import type {HardhatPlugin} from 'hardhat/types/plugins';

// Import type extensions
import './type-extensions.js';

const hardhatExternalArtifactsPlugin: HardhatPlugin = {
	id: 'hardhat-external-artifacts',
	hookHandlers: {
		config: () => import('./hooks/config.js'),
		network: () => import('./hooks/network.js'),
	},
};

export default hardhatExternalArtifactsPlugin;
export * from './artifacts/types.js';
