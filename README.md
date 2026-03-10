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

Import the plugin in your Hardhat configuration file:

```typescript
// hardhat.config.ts
import type { HardhatUserConfig } from "hardhat/config";
import "hardhat-external-artifacts";

const config: HardhatUserConfig = {
  solidity: "0.8.20",
  externalArtifacts: {
    // Load specific artifact files
    paths: [
      "./external-artifacts/WETH.json",
      "./external-artifacts/Uniswap/", // Loads all .json in directory
    ],
    // Optional: specify solc version for synthetic compilations
    solcVersion: "0.8.20",
    // Optional: disable warnings for invalid artifacts
    warnOnInvalidArtifacts: true,
  },
};

export default config;
```

### Using a Resolver Function

For more dynamic artifact loading, you can use a resolver function:

```typescript
// hardhat.config.ts
import type { HardhatUserConfig } from "hardhat/config";
import "hardhat-external-artifacts";

const config: HardhatUserConfig = {
  solidity: "0.8.20",
  externalArtifacts: {
    resolver: async () => {
      // Fetch from API, database, or any source
      return [
        {
          contractName: "ERC20",
          sourceName: "openzeppelin/ERC20.sol",
          abi: [
            /* ... */
          ],
          bytecode: "0x...",
          deployedBytecode: "0x...",
        },
      ];
    },
    solcVersion: "0.8.20",
  },
};

export default config;
```

### Combined Approach

You can use both paths and resolver together:

```typescript
// hardhat.config.ts
import type { HardhatUserConfig } from "hardhat/config";
import "hardhat-external-artifacts";
import { loadDefiProtocolArtifacts } from "./scripts/load-defi";

const config: HardhatUserConfig = {
  solidity: "0.8.20",
  externalArtifacts: {
    // Load from local directory
    paths: ["./vendor-artifacts/"],

    // Also fetch dynamically
    resolver: async () => loadDefiProtocolArtifacts(),

    // Use specific solc version for method ID computation
    solcVersion: "0.8.19",

    // Silence warnings for experimental use
    warnOnInvalidArtifacts: false,
  },
};

export default config;
```

## Configuration Options

| Option                   | Type                                    | Default    | Description                                           |
| ------------------------ | --------------------------------------- | ---------- | ----------------------------------------------------- |
| `paths`                  | `string[]`                              | `[]`       | Paths to artifact files or directories                |
| `resolver`               | `() => Promise<ExternalArtifact[]>`     | `undefined`| Function that returns artifacts dynamically           |
| `solcVersion`            | `string`                                | `"0.8.20"` | Solc version for synthetic compilations               |
| `warnOnInvalidArtifacts` | `boolean`                               | `true`     | Whether to log warnings for malformed artifacts       |

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

## Requirements

- Hardhat 3.x
- Node.js 22+

## License

MIT
