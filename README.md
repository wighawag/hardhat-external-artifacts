# hardhat-external-artifacts

A Hardhat 3 plugin that allows users to provide external contract artifacts (ABIs) to Hardhat's EDR provider for decoding events, errors, and function calls in console output.

This is useful when interacting with contracts that were not compiled by the current Hardhat project (e.g., external protocols, deployed contracts from other projects).

## Installation

```bash
npm install hardhat-external-artifacts
# or
pnpm add hardhat-external-artifacts
# or
yarn add hardhat-external-artifacts
```

## Usage

Import the plugin and add it to the `plugins` array in your Hardhat configuration file:

```typescript
// hardhat.config.ts
import type {HardhatUserConfig} from 'hardhat/config';
import HardhatExternalArtifactsPlugin from 'hardhat-external-artifacts';

const config: HardhatUserConfig = {
	plugins: [HardhatExternalArtifactsPlugin],
	solidity: '0.8.20',
	externalArtifacts: {
		// Load specific artifact files
		paths: [
			'./external-artifacts/WETH.json',
			'./external-artifacts/Uniswap/', // Loads all .json in directory
		],
		// Optional: specify solc version for synthetic compilations
		solcVersion: '0.8.20',
		// Optional: disable warnings for invalid artifacts
		warnOnInvalidArtifacts: true,
	},
};

export default config;
```

### Loading from npm Packages

You can load artifacts directly from npm packages using the `modules` option. This uses Node.js module resolution, supporting both package exports and direct paths:

```typescript
// hardhat.config.ts
import type {HardhatUserConfig} from 'hardhat/config';
import HardhatExternalArtifactsPlugin from 'hardhat-external-artifacts';

const config: HardhatUserConfig = {
	plugins: [HardhatExternalArtifactsPlugin],
	solidity: '0.8.20',
	externalArtifacts: {
		// Load from npm packages via module resolution
		modules: [
			'@my-org/contracts/artifacts',     // Uses package.json "exports"
			'some-package/dist/artifacts',     // Direct path in package
		],
	},
};

export default config;
```

**Note:** The `modules` option differs from `paths` in that it resolves module specifiers from `node_modules` using Node.js resolution, respecting the package's `exports` field. This is useful when a package explicitly exports its artifacts folder.

For example, if a package has:
```json
{
  "name": "@my-org/contracts",
  "exports": {
    "./artifacts": "./dist/artifacts"
  }
}
```

Then using `modules: ['@my-org/contracts/artifacts']` will correctly resolve to the exported path.

### Using a Resolver Function

For more dynamic artifact loading, you can use a resolver function:

```typescript
// hardhat.config.ts
import type {HardhatUserConfig} from 'hardhat/config';
import HardhatExternalArtifactsPlugin from 'hardhat-external-artifacts';

const config: HardhatUserConfig = {
	plugins: [HardhatExternalArtifactsPlugin],
	solidity: '0.8.20',
	externalArtifacts: {
		resolver: async () => {
			// Fetch from API, database, or any source
			return [
				{
					contractName: 'ERC20',
					sourceName: 'openzeppelin/ERC20.sol',
					abi: [
						/* ... */
					],
					bytecode: '0x...',
					deployedBytecode: '0x...',
				},
			];
		},
		solcVersion: '0.8.20',
	},
};

export default config;
```

### Combined Approach

You can use both paths and resolver together:

```typescript
// hardhat.config.ts
import type {HardhatUserConfig} from 'hardhat/config';
import HardhatExternalArtifactsPlugin from 'hardhat-external-artifacts';
import {loadDefiProtocolArtifacts} from './scripts/load-defi';

const config: HardhatUserConfig = {
	plugins: [HardhatExternalArtifactsPlugin],
	solidity: '0.8.20',
	externalArtifacts: {
		// Load from local directory
		paths: ['./vendor-artifacts/'],

		// Also fetch dynamically
		resolver: async () => loadDefiProtocolArtifacts(),

		// Use specific solc version for method ID computation
		solcVersion: '0.8.19',

		// Silence warnings for experimental use
		warnOnInvalidArtifacts: false,
	},
};

export default config;
```

## Configuration Options

| Option                   | Type                                | Default     | Description                                              |
| ------------------------ | ----------------------------------- | ----------- | -------------------------------------------------------- |
| `paths`                  | `string[]`                          | `[]`        | Paths to artifact files or directories (relative/absolute) |
| `modules`                | `string[]`                          | `[]`        | Module specifiers to resolve from node_modules           |
| `resolver`               | `() => Promise<ExternalArtifact[]>` | `undefined` | Function that returns artifacts dynamically              |
| `solcVersion`            | `string`                            | `"0.8.20"`  | Solc version for synthetic compilations                  |
| `warnOnInvalidArtifacts` | `boolean`                           | `true`      | Whether to log warnings for malformed artifacts          |
| `debug`                  | `boolean`                           | `false`     | Enable debug logging for troubleshooting                 |

## Artifact Format

### Simple Artifact

The minimum required format for an external artifact:

```json
{
  "contractName": "MyContract",
  "sourceName": "contracts/MyContract.sol",
  "abi": [...],
  "bytecode": "0x...",
  "deployedBytecode": "0x..."
}
```

### Rich Artifact

For better fidelity, you can provide a rich artifact with embedded compilation data:

```json
{
  "contractName": "MyContract",
  "sourceName": "contracts/MyContract.sol",
  "abi": [...],
  "bytecode": "0x...",
  "deployedBytecode": "0x...",
  "solcInput": "{\"language\":\"Solidity\",...}",
  "metadata": "{\"compiler\":{\"version\":\"0.8.20+commit...\"},...}",
  "evm": {
    "bytecode": { "object": "...", "sourceMap": "...", ... },
    "deployedBytecode": { "object": "...", "sourceMap": "...", ... },
    "methodIdentifiers": { "transfer(address,uint256)": "a9059cbb" }
  }
}
```

Rich artifacts are typically produced by tools like `hardhat-deploy` that preserve full compilation output.

## How It Works

1. When a network connection is established (specifically for EDR/Hardhat Network), the plugin loads the configured external artifacts.

2. Simple artifacts are grouped into a synthetic compilation with computed method identifiers.

3. Rich artifacts (with embedded `solcInput`) get their own individual compilations for maximum fidelity.

4. The compilations are added to the EDR provider using `addCompilationResult()`, enabling:
   - Event decoding in transaction logs
   - Error decoding for reverts
   - Function call decoding in stack traces

## Troubleshooting

### Contract still shows as `<UnrecognizedContract>`

If you see logs like:
```
eth_call
  Contract call:             <UnrecognizedContract>
  From:                      0x...
  To:                        0x...
```

This means EDR couldn't match the contract's bytecode. EDR identifies contracts by matching the **deployed bytecode** at the target address with bytecode from compilation results.

**Possible causes:**

1. **Bytecode mismatch**: The `deployedBytecode` in your artifact doesn't match what's actually deployed. This can happen due to:
   - Different compiler versions or optimizer settings
   - Metadata hash differences (appended to bytecode by default)
   - Constructor arguments that set immutable values

2. **Missing bytecode**: Your artifact has an empty or missing `deployedBytecode` field.

**Debugging steps:**

1. Enable debug logging:
   ```typescript
   externalArtifacts: {
     paths: ['./artifacts/'],
     debug: true,  // Enable debug output
   }
   ```

2. Verify bytecode exists and has reasonable length in the debug output.

3. Compare your artifact's `deployedBytecode` with the actual bytecode at the address:
   ```typescript
   // In your test/script
   const actualCode = await connection.provider.request({
     method: 'eth_getCode',
     params: [contractAddress, 'latest'],
   });
   console.log('Actual bytecode length:', actualCode.length);
   console.log('Artifact bytecode length:', artifact.deployedBytecode.length);
   ```

4. For forked networks, ensure you have the exact artifact that was used to deploy the contract on mainnet. Minor differences (like metadata hash) will prevent matching.

### Rich artifacts vs Simple artifacts

Rich artifacts (with `solcInput`) provide better matching because they include the complete compilation data. If you have access to the original compilation output (e.g., from `hardhat-deploy`), prefer using rich artifacts.

## Requirements

- Hardhat 3.x
- Node.js 22+

## License

MIT
