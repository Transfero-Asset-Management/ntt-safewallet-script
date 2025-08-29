import { Wallet, JsonRpcProvider } from "ethers";
import SafeApiKit from '@safe-global/api-kit'
import Safe from '@safe-global/protocol-kit'
import {
    MetaTransactionData,
    OperationType
} from '@safe-global/safe-core-sdk-types'
import { getOptimizedGasConfig } from './utils/gas-config'

export async function proposeTransaction(
    chainId: number,
    safeAddress: string,
    toAddress: string,
    value: string,
    callData: string,
    signerWallet: Wallet,
    rpcUrl: string
): Promise<{ safeTxHash: string; txHash: string | undefined }> {
    const provider = new JsonRpcProvider(rpcUrl);
    const apiKit = getSafeApiKit(chainId);

    const protocolKitOwner = await Safe.init({
        provider: rpcUrl,
        signer: signerWallet.privateKey,
        safeAddress: safeAddress
    });

    const safeTransactionData: MetaTransactionData = {
        to: toAddress,
        value: value,
        data: callData,
        operation: OperationType.Call
    };

    let safeTxHash: string;

    // Check if transaction with same data already exists
    const pendingTransactions = await apiKit.getPendingTransactions(safeAddress);
    const existingTx = pendingTransactions.results.find(tx =>
        tx.data === safeTransactionData.data && tx.to.toLowerCase() === safeTransactionData.to.toLowerCase()
    );
    if (existingTx) {
        console.log(`Transaction already exists. SafeTxHash: ${existingTx.safeTxHash}`);
        safeTxHash = existingTx.safeTxHash;
    } else {
        let safeTransaction = await protocolKitOwner.createTransaction({
            transactions: [safeTransactionData]
        });

        safeTxHash = await protocolKitOwner.getTransactionHash(safeTransaction);

        const signature = await protocolKitOwner.signHash(safeTxHash);

        const senderAddress = await signerWallet.getAddress();

        // Propose transaction to the service
        await apiKit.proposeTransaction({
            safeAddress: safeAddress,
            safeTransactionData: safeTransaction.data,
            safeTxHash,
            senderAddress: senderAddress,
            senderSignature: signature.data
        });

        console.log(`Transaction proposed. SafeTxHash: ${safeTxHash}`);
    }

    const txHash = await waitForSafeTxConfirmation(provider, chainId, safeTxHash);
    return { safeTxHash, txHash };
};

export async function proposeTransactionOnly(
    chainId: number,
    safeAddress: string,
    toAddress: string,
    value: string,
    callData: string,
    signerWallet: Wallet,
    rpcUrl: string
): Promise<string> {
    const apiKit = getSafeApiKit(chainId);

    const protocolKitOwner = await Safe.init({
        provider: rpcUrl,
        signer: signerWallet.privateKey,
        safeAddress: safeAddress
    });

    const safeTransactionData: MetaTransactionData = {
        to: toAddress,
        value: value,
        data: callData,
        operation: OperationType.Call
    };

    let safeTxHash: string;

    // Check if transaction with same data already exists
    const pendingTransactions = await apiKit.getPendingTransactions(safeAddress);
    const existingTx = pendingTransactions.results.find(tx =>
        tx.data === safeTransactionData.data && tx.to.toLowerCase() === safeTransactionData.to.toLowerCase()
    );
    if (existingTx) {
        console.log(`[NTTService] Transaction already exists. SafeTxHash: ${existingTx.safeTxHash}`);
        safeTxHash = existingTx.safeTxHash;
    } else {
        let safeTransaction = await protocolKitOwner.createTransaction({
            transactions: [safeTransactionData]
        });

        safeTxHash = await protocolKitOwner.getTransactionHash(safeTransaction);

        const signature = await protocolKitOwner.signHash(safeTxHash);

        const senderAddress = await signerWallet.getAddress();

        // Propose transaction to the service
        await apiKit.proposeTransaction({
            safeAddress: safeAddress,
            safeTransactionData: safeTransaction.data,
            safeTxHash,
            senderAddress: senderAddress,
            senderSignature: signature.data
        });

        console.log(`[NTTService] Transaction proposed. SafeTxHash: ${safeTxHash}`);
    }

    // Get transaction details to return status
    const transactionDetails = await apiKit.getTransaction(safeTxHash);
    const confirmations = transactionDetails.confirmations || [];
    
    console.log(`[NTTService] Current confirmations: ${confirmations.length}/${transactionDetails.confirmationsRequired}`);
    if (confirmations.length > 0) {
        confirmations.forEach((confirmation, index) => {
            console.log(`[NTTService] Signer ${index + 1}: ${confirmation.owner}`);
        });
    }
    
    if (confirmations.length >= transactionDetails.confirmationsRequired) {
        console.log(`[NTTService] Transaction has all required confirmations and is ready for execution.`);
    }

    return safeTxHash;
};

export async function proposeBundledTransaction(
    chainId: number,
    safeAddress: string,
    transactions: Array<{to: string, value: string, data: string}>,
    signerWallet: Wallet,
    rpcUrl: string
): Promise<{safeTxHash: string, executed: boolean, executionTxHash?: string}> {
    const provider = new JsonRpcProvider(rpcUrl);
    const apiKit = getSafeApiKit(chainId);

    // Force refresh Safe state by not using any cache
    const protocolKitOwner = await Safe.init({
        provider: rpcUrl,
        signer: signerWallet.privateKey,
        safeAddress: safeAddress,
        isL1SafeSingleton: false // Force fresh initialization
    });

    // Convert transactions to MetaTransactionData format
    const safeTransactionData: MetaTransactionData[] = transactions.map(tx => ({
        to: tx.to,
        value: tx.value,
        data: tx.data,
        operation: OperationType.Call
    }));

    console.log(`[NTTService] Creating bundled transaction with ${safeTransactionData.length} operations`);

    // Get the current nonce to ensure we're using the latest
    const currentNonce = await protocolKitOwner.getNonce();
    console.log(`[NTTService] Current Safe nonce from contract: ${currentNonce}`);
    
    // Check pending transactions to see if we need a higher nonce
    const pendingTxs = await apiKit.getPendingTransactions(safeAddress);
    const pendingNonces = pendingTxs.results.map(tx => tx.nonce);
    const maxPendingNonce = pendingNonces.length > 0 ? Math.max(...pendingNonces) : -1;
    
    if (maxPendingNonce >= currentNonce) {
        console.log(`[NTTService] ⚠️ Found pending transaction with nonce ${maxPendingNonce}`);
        console.log(`[NTTService] Contract nonce is ${currentNonce}, but pending tx exists`);
    }
    
    // Create multi-transaction - let SDK handle nonce automatically
    let safeTransaction = await protocolKitOwner.createTransaction({
        transactions: safeTransactionData
        // Remove explicit nonce setting - let SDK handle it
    });

    // Log the actual transaction data being used
    console.log(`[NTTService] Transaction details:`);
    console.log(`[NTTService]   - Nonce: ${safeTransaction.data.nonce}`);
    console.log(`[NTTService]   - To: ${safeTransaction.data.to}`);
    console.log(`[NTTService]   - Value: ${safeTransaction.data.value}`);
    console.log(`[NTTService]   - Data length: ${safeTransaction.data.data.length} bytes`);
    console.log(`[NTTService]   - Data hash: ${require('crypto').createHash('sha256').update(safeTransaction.data.data).digest('hex').substring(0, 16)}...`);

    const safeTxHash = await protocolKitOwner.getTransactionHash(safeTransaction);
    console.log(`[NTTService] Generated SafeTxHash: ${safeTxHash}`);
    
    const signature = await protocolKitOwner.signHash(safeTxHash);
    const senderAddress = await signerWallet.getAddress();

    // Check if this transaction already exists
    try {
        const existingTx = await apiKit.getTransaction(safeTxHash);
        console.log(`[NTTService] ⚠️ DUPLICATE SAFETXHASH DETECTED: ${safeTxHash}`);
        console.log(`[NTTService] This means the same transaction parameters and nonce were used!`);
        console.log(`[NTTService]   - Transaction nonce: ${safeTransaction.data.nonce}`);
        console.log(`[NTTService]   - Is executed: ${existingTx.isExecuted}`);
        console.log(`[NTTService]   - Is successful: ${existingTx.isSuccessful}`);
        console.log(`[NTTService]   - Confirmations: ${existingTx.confirmations?.length || 0}/${existingTx.confirmationsRequired}`);
        
        if (existingTx.isExecuted) {
            console.log(`[NTTService] ⚠️ This transaction was already executed!`);
            console.log(`[NTTService]   - Execution date: ${existingTx.executionDate}`);
            console.log(`[NTTService]   - Transaction hash: ${existingTx.transactionHash}`);
            console.log(`[NTTService]   - Original nonce: ${existingTx.nonce}`);
            
            // Return the existing executed transaction instead of trying to recreate it
            return { 
                safeTxHash, 
                executed: true, 
                executionTxHash: existingTx.transactionHash || undefined
            };
        } else {
            console.log(`[NTTService] Transaction exists but not executed. Will add signature.`);
        }
    } catch (error) {
        console.log(`[NTTService] Transaction ${safeTxHash} not found in Safe service (will create new)`);
        console.log(`[NTTService]   - Using nonce: ${safeTransaction.data.nonce}`);
    }

    // Propose transaction to the service
    try {
        await apiKit.proposeTransaction({
            safeAddress: safeAddress,
            safeTransactionData: safeTransaction.data,
            safeTxHash,
            senderAddress: senderAddress,
            senderSignature: signature.data
        });
        console.log(`[NTTService] Bundled transaction proposed. SafeTxHash: ${safeTxHash}`);
    } catch (proposeError: any) {
        // If the transaction already exists, that's ok - we can still try to execute it
        if (proposeError.message && proposeError.message.includes('already exists')) {
            console.log(`[NTTService] Transaction already exists in Safe service, continuing...`);
        } else {
            throw proposeError;
        }
    }

    // Check if we can execute immediately (threshold = 1)
    const safeInfo = await protocolKitOwner.getThreshold();
    const owners = await protocolKitOwner.getOwners();
    
    console.log(`[NTTService] Safe address: ${safeAddress}`);
    console.log(`[NTTService] Safe threshold: ${safeInfo}, Owners: ${owners.length}`);
    console.log(`[NTTService] Signer address: ${senderAddress}`);
    console.log(`[NTTService] Is signer an owner: ${owners.includes(senderAddress)}`);
    
    // Convert threshold to number for comparison
    const thresholdNumber = Number(safeInfo);
    
    if (thresholdNumber === 1 && owners.includes(senderAddress)) {
        console.log(`[NTTService] Threshold is 1 and signer is owner. Will execute transaction...`);
        
        // Wait for the Safe service to fully index the transaction
        console.log(`[NTTService] Waiting 5 seconds for Safe service to fully process the transaction...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        console.log(`[NTTService] Executing transaction now...`);
        
        try {
            // Get optimized gas configuration
            const gasConfig = await getOptimizedGasConfig(provider);
            
            console.log(`[NTTService] Gas configuration:`);
            console.log(`[NTTService]   - maxFeePerGas: ${gasConfig.maxFeePerGas ? (Number(gasConfig.maxFeePerGas) / 1e9).toFixed(2) : 'not set'} gwei`);
            console.log(`[NTTService]   - maxPriorityFeePerGas: ${gasConfig.maxPriorityFeePerGas ? (Number(gasConfig.maxPriorityFeePerGas) / 1e9).toFixed(2) : 'not set'} gwei`);
            console.log(`[NTTService]   - gasLimit: ${gasConfig.gasLimit || 'auto'}`);
            
            // Execute the transaction with gas configuration
            // Add a reasonable gas limit if not set
            const executionOptions: any = {};
            if (gasConfig.maxFeePerGas) {
                executionOptions.maxFeePerGas = gasConfig.maxFeePerGas.toString();
            }
            if (gasConfig.maxPriorityFeePerGas) {
                executionOptions.maxPriorityFeePerGas = gasConfig.maxPriorityFeePerGas.toString();
            }
            // Set a reasonable gas limit for Safe execution
            executionOptions.gasLimit = '500000';
            
            console.log(`[NTTService] Executing transaction with options:`, executionOptions);
            
            const executeTxResponse = await protocolKitOwner.executeTransaction(safeTransaction, executionOptions);
            
            // The response should have transactionResponse property
            if (executeTxResponse && executeTxResponse.transactionResponse) {
                const txResponse = executeTxResponse.transactionResponse as any;
                console.log(`[NTTService] Transaction sent, hash: ${txResponse.hash}`);
                console.log(`[NTTService] Waiting for confirmation (this may take a moment)...`);
                
                // Wait for the transaction with retries
                let receipt;
                try {
                    receipt = await txResponse.wait();
                } catch (waitError: any) {
                    console.warn(`[NTTService] Failed to wait for receipt: ${waitError.message}`);
                    console.log(`[NTTService] Transaction was sent with hash: ${txResponse.hash}`);
                    console.log(`[NTTService] The transaction is likely still being mined. Check the Safe UI.`);
                    
                    // Return with the transaction hash even if we couldn't wait for receipt
                    return { safeTxHash, executed: true, executionTxHash: txResponse.hash };
                }
                
                const executionTxHash = receipt.hash || receipt.transactionHash || undefined;
                console.log(`[NTTService] Transaction confirmed! Hash: ${executionTxHash}`);
                return { safeTxHash, executed: true, executionTxHash };
            } else {
                console.log(`[NTTService] Transaction proposed but not executed (may need manual execution)`);
                return { safeTxHash, executed: false };
            }
        } catch (error: any) {
            console.error(`[NTTService] Failed to execute transaction:`, error.message || error);
            
            // Check Safe balance before execution
            try {
                const safeBalance = await provider.getBalance(safeAddress);
                console.log(`[NTTService] Safe balance: ${safeBalance.toString()} wei (${Number(safeBalance) / 1e18} ETH)`);
                
                if (safeBalance === BigInt(0)) {
                    console.error(`[NTTService] ⚠️ Safe has no native token for gas! Please fund the Safe at ${safeAddress}`);
                }
            } catch (balanceError) {
                console.error(`[NTTService] Could not check Safe balance:`, balanceError);
            }
            
            // Check for specific Safe error codes
            if (error.message && error.message.includes('GS013')) {
                console.error(`[NTTService] ⚠️ This transaction was already executed on-chain!`);
                console.error(`[NTTService] The Safe rejected execution because this exact transaction has been executed before.`);
                console.error(`[NTTService] SafeTxHash: ${safeTxHash}`);
                
                // Try to find the original execution transaction
                try {
                    const txDetails = await apiKit.getTransaction(safeTxHash);
                    if (txDetails.isExecuted && txDetails.transactionHash) {
                        console.log(`[NTTService] Found original execution: ${txDetails.transactionHash}`);
                        console.log(`[NTTService] Executed at: ${txDetails.executionDate}`);
                        return { safeTxHash, executed: true, executionTxHash: txDetails.transactionHash || undefined };
                    }
                } catch (fetchError) {
                    console.error(`[NTTService] Could not fetch transaction details`);
                }
                
                // Return indicating the transaction was already executed (but we don't have the tx hash)
                return { safeTxHash, executed: false };
            }
            
            // Check for missing revert data (usually means insufficient gas)
            if (error.message && error.message.includes('missing revert data')) {
                console.error(`[NTTService] ⚠️ Transaction reverted without data. Common causes:`);
                console.error(`[NTTService]   1. Safe has insufficient native token for gas`);
                console.error(`[NTTService]   2. Safe is trying to execute an invalid operation`);
                console.error(`[NTTService]   3. Network issues or RPC problems`);
            }
            
            // Continue - transaction is still proposed
        }
    }

    return { safeTxHash, executed: false };
};

async function waitForSafeTxConfirmation(
    provider: JsonRpcProvider,
    chainId: number,
    safeTxHash: string,
    confirmations: number = 1
): Promise<string> {
    const apiKit = getSafeApiKit(chainId);

    let isConfirmed = false;
    let transactionHash: string | null = null;
    let previousConfirmationCount = 0;
    let previousLog = false;
    let previousLog2 = false;
    let previousLog3 = false;

    while (!isConfirmed) {
        const transactionDetails = await apiKit.getTransaction(safeTxHash);
        const confirmations = transactionDetails.confirmations;

        if (confirmations) {
            const currentConfirmationCount = confirmations.length;
            if (currentConfirmationCount !== previousConfirmationCount) {
                console.log(`Current confirmations: ${currentConfirmationCount}/${transactionDetails.confirmationsRequired}`);
                confirmations.forEach((confirmation, index) => {
                    console.log(`Signer ${index + 1}: ${confirmation.owner}`);
                });
                previousConfirmationCount = currentConfirmationCount;
                previousLog2 = false;
                previousLog3 = false;
                console.log();
            }
        } else if (previousConfirmationCount !== 0) {
            console.log(`No confirmations yet.`);
            previousConfirmationCount = 0;
        }
        if (transactionDetails.isExecuted) {
            transactionHash = transactionDetails.transactionHash;
            console.log(`Transaction executed. Hash: ${transactionHash}`);
            isConfirmed = true;
        } else if (transactionDetails.isSuccessful === false) {
            console.log(`Transaction was rejected.`);
            isConfirmed = true;
        } else {
            if (transactionDetails.confirmationsRequired === previousConfirmationCount) {
                if (!previousLog3) {
                    console.log(`Transaction has received all required confirmations and is awaiting execution.`);
                    console.log();
                    previousLog3 = true;
                }
            } else if (previousConfirmationCount === 0 && !previousLog) {
                console.log(`Waiting for ${transactionDetails.confirmationsRequired} confirmation(s)...`);
                console.log();
                previousLog = true;
            } else if (previousConfirmationCount !== 0 && !previousLog2) {
                console.log(`Waiting for ${transactionDetails.confirmationsRequired - previousConfirmationCount} more confirmation(s)...`);
                console.log();
                previousLog2 = true;
            }
            // Wait for 3 seconds before checking again
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    }
    if (transactionHash) {
        console.log(`Waiting for ${confirmations} block confirmation(s) on the network...`);
        await provider.waitForTransaction(transactionHash);
    }
    return transactionHash!;
};



function getSafeApiKit(chainId: number) {
    let txServiceUrl: string | undefined;
    if (chainId === 1284) { // moonbeam
        txServiceUrl = 'https://transaction.multisig.moonbeam.network/api';
    } else {
        txServiceUrl = undefined;
    }
    return new SafeApiKit({
        chainId: BigInt(chainId),
        txServiceUrl: txServiceUrl
    });
}
