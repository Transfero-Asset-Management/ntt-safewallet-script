import { Wormhole, amount, Chain, routes } from "@wormhole-foundation/sdk";
import evm from "@wormhole-foundation/sdk/platforms/evm";
import { Wallet } from "ethers";

import "@wormhole-foundation/sdk-evm-ntt";
import { nttExecutorRoute, NttExecutorRoute } from "@wormhole-foundation/sdk-route-ntt";
import { NTT_TOKENS, CHAIN_IDS } from "./utils/const";
import { proposeTransaction } from "./safe";

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  if (args.length < 5) {
    console.log("Usage: ts-node src/index.ts <srcChain> <dstChain> <srcAddress> <dstAddress> <amount>");
    console.log("Example: ts-node src/index.ts Polygon Base 0x123... 0x456... 0.1");
    console.log("Available chains:", Object.keys(CHAIN_IDS));
    process.exit(1);
  }

  return {
    srcChain: args[0] as Chain,
    dstChain: args[1] as Chain,
    srcAddress: args[2],
    dstAddress: args[3],
    amount: args[4]
  };
}

/**
 * Build executor config from NTT_TOKENS
 */
function buildExecutorConfig(): NttExecutorRoute.Config {
  const tokens = Object.entries(NTT_TOKENS)
    .filter(([_, contracts]) => contracts !== undefined)
    .map(([chain, contracts]) => ({
      chain: chain as Chain,
      token: contracts!.token,
      manager: contracts!.manager,
      transceiver: Object.entries(contracts!.transceiver).map(([type, address]) => ({
        type: type as "wormhole",
        address: address as string,
      })),
    }));

  return {
    ntt: {
      tokens: {
        "BRZ": tokens
      }
    },
    referrerFee: {
      feeDbps: 0n, // No referrer fee
    }
  };
}

(async function () {
  const { srcChain, dstChain, srcAddress, dstAddress, amount: transferAmount } = parseArgs();

  console.log(`Transfer: ${transferAmount} from ${srcChain} (${srcAddress}) to ${dstChain} (${dstAddress})`);

  // This CLI tool requires RPCs to be provided via environment variables
  const getRpcUrl = (chain: string) => {
    const envKey = `${chain.toUpperCase()}_RPC`;
    const rpc = process.env[envKey];
    if (!rpc) {
      throw new Error(`RPC URL for ${chain} not found. Please set ${envKey} environment variable`);
    }
    return rpc;
  };

  const wh = new Wormhole("Mainnet", [evm.Platform], {
    "chains": {
      "Base": {
        "rpc": getRpcUrl("Base"),
      },
      "Polygon": {
        "rpc": getRpcUrl("Polygon"),
      },
      "Avalanche": {
        "rpc": getRpcUrl("Avalanche"),
      },
      "Arbitrum": {
        "rpc": getRpcUrl("Arbitrum"),
      },
      "Bsc": {
        "rpc": getRpcUrl("Bsc"),
      },
      "Unichain": {
        "rpc": getRpcUrl("Unichain"),
      }
    }
  });

  const src = wh.getChain(srcChain);
  const dst = wh.getChain(dstChain);

  const srcChainAddress = Wormhole.chainAddress(src.chain, srcAddress);
  const dstChainAddress = Wormhole.chainAddress(dst.chain, dstAddress);

  const privateKey = process.env.ETH_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("ETH_PRIVATE_KEY not found in environment variables");
  }
  const signerWallet = new Wallet(privateKey);

  // Get both Ntt and NttWithExecutor protocols
  const srcNtt = await src.getProtocol("Ntt" as any, {
    ntt: NTT_TOKENS[src.chain],
  }) as any;

  const srcNttExecutor = await src.getProtocol("NttWithExecutor" as any, {
    ntt: NTT_TOKENS[src.chain],
  }) as any;

  const amt = amount.units(
    amount.parse(transferAmount, await srcNtt.getTokenDecimals())
  );

  // Setup executor route and get quote
  console.log(`Fetching executor quote...`);
  const executorConfig = buildExecutorConfig();
  const executorRoute = nttExecutorRoute(executorConfig);
  const routeInstance = new executorRoute(wh as any);

  const srcTokenAddr = NTT_TOKENS[srcChain]!.token;
  const dstTokenAddr = NTT_TOKENS[dstChain]!.token;

  const tr = await routes.RouteTransferRequest.create(wh as any, {
    source: Wormhole.tokenId(srcChain, srcTokenAddr),
    destination: Wormhole.tokenId(dstChain, dstTokenAddr),
  });

  const validated = await routeInstance.validate(tr, { amount: transferAmount });
  if (!validated.valid) {
    throw new Error(`Executor validation failed: ${validated.error?.message || 'Unknown error'}`);
  }

  const executorQuote = await routeInstance.fetchExecutorQuote(tr, validated.params as NttExecutorRoute.ValidatedParams);
  console.log(`Executor quote received:`);
  console.log(`  Estimated cost: ${executorQuote.estimatedCost.toString()} wei`);
  console.log(`  Expires: ${executorQuote.expires.toISOString()}`);

  // Create transfer using executor
  const xfer = () => srcNttExecutor.transfer(
    srcChainAddress.address,
    dstChainAddress,
    amt,
    executorQuote,
    srcNtt
  );

  // Iterate through all transactions from xfer() and propose each one
  const txHashes: string[] = [];

  const txGenerator = xfer();
  let step = await txGenerator.next();

  while (!step.done) {
    const transaction = step.value.transaction;
    console.log(`Proposing transaction to: ${transaction.to}`);
    console.log(`Transaction data: ${transaction.data}`);

    console.log(transaction);

    const { safeTxHash, txHash } = await proposeTransaction(
      CHAIN_IDS[src.chain],
      srcChainAddress.address.toString(),
      transaction.to,
      transaction.value ? transaction.value.toString() : "0",
      transaction.data,
      signerWallet,
      src.config.rpc
    );

    if (txHash) {
      txHashes.push(txHash);
    }

    console.log(`Safe transaction proposed. SafeTxHash: ${safeTxHash}`);
    if (txHash) {
      console.log(`Transaction executed. TxHash: ${txHash}`);
    }

    // Get next transaction
    step = await txGenerator.next();
  }

  console.log("All transactions sent:", txHashes);

  if (txHashes.length > 0) {
    const lastTxHash = txHashes[txHashes.length - 1];

    const status = await wh.getTransactionStatus(lastTxHash, 25 * 60 * 1000);
    console.log("Status:", status);
  } else {
    console.log("No transactions were executed yet. Check Safe for pending transactions.");
  }
})();
