import { LAMPORTS_PER_SOL, clusterApiUrl } from "@solana/web3.js";
import { ArbBot, SwapToken } from './bot';
import dotenv from "dotenv";
import express from "express";

dotenv.config({
    path: ".env",
});

const defaultConfig = {
    solanaEndpoint: clusterApiUrl("mainnet-beta"),
    jupiter: "https://public.jupiterapi.com",
};

// Set up Express server for webhooks
const app = express();
app.use(express.json()); // Middleware to parse JSON

async function main() {
    if (!process.env.SECRET_KEY) {
        throw new Error("SECRET_KEY environment variable not set");
    }

    // Decode the secret key from environment variable
    let decodedSecretKey = Uint8Array.from(JSON.parse(process.env.SECRET_KEY));

    // Create the ArbBot instance
    const bot = new ArbBot({
        solanaEndpoint: process.env.SOLANA_ENDPOINT ?? defaultConfig.solanaEndpoint,
        metisEndpoint: process.env.METIS_ENDPOINT ?? defaultConfig.jupiter,
        secretKey: decodedSecretKey,
    });

    // Initialize bot with balances and other required setup
    await bot.init();

    // Set up webhook handling for TradingView alerts (buy/sell)
    app.post('/webhook', async (req, res) => {
        const { action } = req.body;

        // Ensure the action is valid ('buy' or 'sell')
        if (action !== 'buy' && action !== 'sell') {
            return res.status(400).send("Invalid action. Must be 'buy' or 'sell'.");
        }

        try {
            // Call bot to handle webhook signal
            await bot.handleWebhook(action);
            res.status(200).send(`Action ${action} executed successfully.`);
        } catch (error) {
            console.error(`Error executing ${action}:`, error);
            res.status(500).send(`Failed to execute ${action}.`);
        }
    });

    // Start listening for webhooks on port 3000
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Webhook server is listening on port ${PORT}`);
    });
}

// Execute main function and catch any errors
main().catch(console.error);