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

    const protocolKitOwner = await Safe.init({
        provider: rpcUrl,
        signer: signerWallet.privateKey,
        safeAddress: safeAddress
    });

    // Convert transactions to MetaTransactionData format
    const safeTransactionData: MetaTransactionData[] = transactions.map(tx => ({
        to: tx.to,
        value: tx.value,
        data: tx.data,
        operation: OperationType.Call
    }));

    console.log(`[NTTService] Creating bundled transaction with ${safeTransactionData.length} operations`);

    // Create multi-transaction
    let safeTransaction = await protocolKitOwner.createTransaction({
        transactions: safeTransactionData
    });

    const safeTxHash = await protocolKitOwner.getTransactionHash(safeTransaction);
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

    console.log(`[NTTService] Bundled transaction proposed. SafeTxHash: ${safeTxHash}`);

    // Check if we can execute immediately (threshold = 1)
    const safeInfo = await protocolKitOwner.getThreshold();
    const owners = await protocolKitOwner.getOwners();
    
    console.log(`[NTTService] Safe threshold: ${safeInfo}, Owners: ${owners.length}`);
    
    if (safeInfo === 1 && owners.includes(senderAddress)) {
        console.log(`[NTTService] Threshold is 1 and signer is owner. Executing transaction...`);
        
        try {
            // Get optimized gas configuration
            const gasConfig = await getOptimizedGasConfig(provider);
            
            // Execute the transaction with gas configuration
            const executeTxResponse = await protocolKitOwner.executeTransaction(safeTransaction, {
                gasLimit: gasConfig.gasLimit?.toString(),
                maxFeePerGas: gasConfig.maxFeePerGas?.toString(),
                maxPriorityFeePerGas: gasConfig.maxPriorityFeePerGas?.toString()
            } as any);
            
            // The response should have transactionResponse property
            if (executeTxResponse && executeTxResponse.transactionResponse) {
                const txResponse = executeTxResponse.transactionResponse as any;
                const receipt = await txResponse.wait();
                
                const executionTxHash = receipt.hash || receipt.transactionHash;
                console.log(`[NTTService] Transaction executed! Hash: ${executionTxHash}`);
                return { safeTxHash, executed: true, executionTxHash };
            } else {
                console.log(`[NTTService] Transaction proposed but not executed (may need manual execution)`);
                return { safeTxHash, executed: false };
            }
        } catch (error) {
            console.error(`[NTTService] Failed to execute transaction:`, error);
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
