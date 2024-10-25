import express from 'express';
import { Keypair, Connection, PublicKey, VersionedTransaction, LAMPORTS_PER_SOL, TransactionInstruction, AddressLookupTableAccount, TransactionMessage } from "@solana/web3.js";
import { createJupiterApiClient, DefaultApi, ResponseError, QuoteGetRequest, QuoteResponse, Instruction, AccountMeta } from '@jup-ag/api';
import { getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount } from "@solana/spl-token";
import * as fs from 'fs';
import * as path from 'path';

interface LogSwapArgs {
    inputToken: string;
    inAmount: string;
    outputToken: string;
    outAmount: string;
    txId: string;
    timestamp: string;
}

interface ArbBotConfig {
    solanaEndpoint: string;
    metisEndpoint: string;
    secretKey: Uint8Array;
}

enum SwapToken {
    SOL,
    USDC
}

class ArbBot {
    private solanaConnection: Connection;
    private jupiterApi: DefaultApi;
    private wallet: Keypair;
    private usdcMint: PublicKey = new PublicKey("EPjFWdd5AufqSSqeM2q5kR4ZSvUCgQ7Qro3LPLRWTJh");
    private solMint: PublicKey = new PublicKey("So11111111111111111111111111111111111111112");
    private usdcTokenAccount: PublicKey;
    private solBalance: number = 0;
    private usdcBalance: number = 0;
    private solGasReserve = 0.201 * LAMPORTS_PER_SOL; // Reserve 0.201 SOL for gas fees

    constructor(config: ArbBotConfig) {
        const { solanaEndpoint, metisEndpoint, secretKey } = config;
        this.solanaConnection = new Connection(solanaEndpoint);
        this.jupiterApi = createJupiterApiClient({ basePath: metisEndpoint });
        this.wallet = Keypair.fromSecretKey(secretKey);
    }

    // Initialize balances
    async init(): Promise<void> {
        console.log(`Bot initiated for wallet: ${this.wallet.publicKey.toBase58()}.`);

        // Ensure the USDC token account exists, or create it
        const account = await getOrCreateAssociatedTokenAccount(
            this.solanaConnection,
            this.wallet,
            this.usdcMint,
            this.wallet.publicKey
        );
        this.usdcTokenAccount = account.address;

        await this.refreshBalances();
        console.log(`Balances: SOL: ${(this.solBalance / LAMPORTS_PER_SOL).toFixed(4)}, USDC: ${this.usdcBalance.toFixed(2)}`);
    }

    // Webhook handler
    async handleWebhook(action: 'buy' | 'sell'): Promise<void> {
        try {
            await this.refreshBalances();
            if (action === 'sell') {
                await this.sellWholeSOL();
            } else if (action === 'buy') {
                await this.buySOLWithAllUSDC();
            }
        } catch (error) {
            console.error(`Webhook handling failed: ${error}`);
        }
    }

    // Sell only whole SOL coins, keeping some SOL for gas fees
    private async sellWholeSOL(): Promise<void> {
        if (this.solBalance <= this.solGasReserve) {
            console.log("Not enough SOL to cover gas fees.");
            return;
        }

        const wholeSolToSell = Math.floor((this.solBalance - this.solGasReserve) / LAMPORTS_PER_SOL);
        if (wholeSolToSell < 1) {
            console.log("No whole SOL available to sell.");
            return;
        }

        await this.executeTrade(SwapToken.SOL, wholeSolToSell * LAMPORTS_PER_SOL);
    }

    private async buySOLWithAllUSDC(): Promise<void> {
        if (this.usdcBalance === 0) {
            console.log("No USDC available for trade.");
            return;
        }

        await this.executeTrade(SwapToken.USDC, this.usdcBalance);
    }

    private async executeTrade(fromToken: SwapToken, amount: number): Promise<void> {
        const inputMint = fromToken === SwapToken.SOL ? this.solMint : this.usdcMint;
        const outputMint = fromToken === SwapToken.SOL ? this.usdcMint : this.solMint;

        const quoteRequest: QuoteGetRequest = {
            inputMint: inputMint.toBase58(),
            outputMint: outputMint.toBase58(),
            amount
        };

        try {
            const quote = await this.jupiterApi.quoteGet(quoteRequest);
            if (quote) {
                await this.executeSwap(quote);
            } else {
                console.log("No quote available.");
            }
        } catch (error) {
            console.error("Error during trade execution:", error);
        }
    }

    private async refreshBalances(): Promise<void> {
        try {
            const [solResult, usdcResult] = await Promise.all([
                this.solanaConnection.getBalance(this.wallet.publicKey),
                this.solanaConnection.getTokenAccountBalance(this.usdcTokenAccount)
            ]);

            this.solBalance = solResult;
            this.usdcBalance = usdcResult.value.uiAmount || 0;
        } catch (error) {
            console.error("Error refreshing balances:", error);
        }
    }

    private async executeSwap(route: QuoteResponse): Promise<void> {
        try {
            const { swapInstruction, cleanupInstruction } = await this.jupiterApi.swapInstructionsPost({
                swapRequest: {
                    quoteResponse: route,
                    userPublicKey: this.wallet.publicKey.toBase58(),
                },
            });

            const instructions: TransactionInstruction[] = [
                this.instructionDataToTransactionInstruction(swapInstruction),
                this.instructionDataToTransactionInstruction(cleanupInstruction)
            ].filter(Boolean);  // Remove nulls

            const { blockhash, lastValidBlockHeight } = await this.solanaConnection.getLatestBlockhash();

            const message = new TransactionMessage({
                payerKey: this.wallet.publicKey,
                recentBlockhash: blockhash,
                instructions,
            }).compileToV0Message([]);

            const transaction = new VersionedTransaction(message);
            transaction.sign([this.wallet]);

            const txid = await this.solanaConnection.sendRawTransaction(transaction.serialize(), { skipPreflight: true });
            await this.solanaConnection.confirmTransaction({ signature: txid, blockhash, lastValidBlockHeight }, 'finalized');

            console.log(`Swap executed successfully. TXID: ${txid}`);
        } catch (error) {
            console.error("Error executing swap:", error);
        }
    }

    private instructionDataToTransactionInstruction(instruction: Instruction | undefined): TransactionInstruction | null {
        if (!instruction) return null;
        return new TransactionInstruction({
            programId: new PublicKey(instruction.programId),
            keys: instruction.accounts.map((key: AccountMeta) => ({
                pubkey: new PublicKey(key.pubkey),
                isSigner: key.isSigner,
                isWritable: key.isWritable,
            })),
            data: Buffer.from(instruction.data, "base64"),
        });
    }
}

// Express server to handle webhooks
const app = express();
app.use(express.json());

// Validate incoming webhook data
const validateWebhook = (req: any, res: any, next: any) => {
    const { action } = req.body;
    if (action !== 'buy' && action !== 'sell') {
        return res.status(400).send("Invalid action.");
    }
    next();
};

const arbBot = new ArbBot({
    solanaEndpoint: process.env.SOLANA_RPC_ENDPOINT || "<SOLANA_RPC_ENDPOINT>",
    metisEndpoint: process.env.JUPITER_API_ENDPOINT || "<JUPITER_API_ENDPOINT>",
    secretKey: new Uint8Array(JSON.parse(fs.readFileSync('<YOUR_SECRET_KEY_FILE>', 'utf-8')))
});

arbBot.init();

// Webhook for TradingView actions
app.post('/webhook', validateWebhook, async (req, res) => {
    const { action } = req.body;
    await arbBot.handleWebhook(action);
    res.status(200).send("Trade executed.");
});

app.listen(3000, () => {
    console.log("Listening for webhooks on port 3000.");
});