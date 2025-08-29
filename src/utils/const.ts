import { Ntt } from "@wormhole-foundation/sdk-definitions-ntt";
import { Chain } from "@wormhole-foundation/sdk";

export type NttContracts = {
  [key in Chain]?: Ntt.Contracts;
};

// Removed ChainConfig and ChainConfigs - no longer needed
// RPCs are provided by the database/service layer

export const NTT_TOKENS: NttContracts = {
  Base: {
    token: "0xE9185Ee218cae427aF7B9764A011bb89FeA761B4",
    manager: "0x8469783eDd405210a5438a4568eA4D0dbcC9CF7f",
    transceiver: { wormhole: "0x337868e39D984aFf7bd8B9F0668cc35d7D2d76C8" },
  },
  Polygon: {
    token: "0x4eD141110F6EeeAbA9A1df36d8c26f684d2475Dc",
    manager: "0x8469783eDd405210a5438a4568eA4D0dbcC9CF7f",
    transceiver: { wormhole: "0x337868e39D984aFf7bd8B9F0668cc35d7D2d76C8" },
  },
  Avalanche: {
    token: "0x05539F021b66Fd01d1FB1ff8E167CdD09bf7c2D0",
    manager: "0x8469783eDd405210a5438a4568eA4D0dbcC9CF7f",
    transceiver: { wormhole: "0x337868e39D984aFf7bd8B9F0668cc35d7D2d76C8" },
  },
  Arbitrum: {
    token: "0xA8940698FdA5A07AbAEf4A5ccDf2f1Bb525B47A2",
    manager: "0x8469783eDd405210a5438a4568eA4D0dbcC9CF7f",
    transceiver: { wormhole: "0x337868e39D984aFf7bd8B9F0668cc35d7D2d76C8" },
  },
  Bsc: {
    token: "0x0295afd3D7E86068050d64509e515f2Db71b4914",
    manager: "0x8469783eDd405210a5438a4568eA4D0dbcC9CF7f",
    transceiver: { wormhole: "0x337868e39D984aFf7bd8B9F0668cc35d7D2d76C8" },
  },
  Unichain: {
    token: "0xE9185Ee218cae427aF7B9764A011bb89FeA761B4",
    manager: "0xd94AC52058C22f8B35E6910bb71239Af834c6bF9",
    transceiver: { wormhole: "0x00169e88f577888cCd18367eE6EA39762C72C600" },
  }
};

// Chain IDs - the only constant we need
export const CHAIN_IDS: Record<string, number> = {
  Base: 8453,
  Polygon: 137,
  Avalanche: 43114,
  Arbitrum: 42161,
  Bsc: 56,
  Unichain: 130,
};