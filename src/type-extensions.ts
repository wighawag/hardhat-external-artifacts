import "hardhat/types/config";
import type { ExternalArtifactsConfig } from "./artifacts/types.js";

/**
 * Resolved external artifacts configuration with defaults applied.
 */
export type ResolvedExternalArtifactsConfig = Required<Omit<ExternalArtifactsConfig, "resolver">> & {
  resolver?: ExternalArtifactsConfig["resolver"];
};

declare module "hardhat/types/config" {
  interface HardhatUserConfig {
    externalArtifacts?: ExternalArtifactsConfig;
  }

  interface HardhatConfig {
    externalArtifacts?: ResolvedExternalArtifactsConfig;
  }
}
