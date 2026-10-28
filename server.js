// index.js - Unified Application Engine & Telegram Broker Layer
import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import TelegramBot from 'node-telegram-bot-api';
import { requestLoanDisbursement } from './momoServer.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-Memory state dict to cache active application objects across request frames
const pendingLoansCache = new Map();

// Initialize the Telegram Bot interface pool
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;

/**
 * API Route: Receive Loan Form Submissions
 */
app.post('/api/loans/apply', async (req, res) => {
    const { fullName, mtnNumber, loanAmount, repaymentPeriodMonths, monthlyIncome, intendedPurpose } = req.body;

    if (!fullName || !mtnNumber || !loanAmount || !repaymentPeriodMonths || !monthlyIncome || !intendedPurpose) {
        return res.status(400).json({ success: false, error: "Validation failure: All fields are mandatory." });
    }

    const months = parseInt(repaymentPeriodMonths);
    if (isNaN(months) || months < 1 || months > 24) {
        return res.status(400).json({ success: false, error: "Invalid horizon parameter: Limits are capped from 1 to 24 months." });
    }

    const applicationId = 'LN-' + Math.floor(100000 + Math.random() * 900000);

    // Save state criteria down to local dictionary memory
    pendingLoansCache.set(applicationId, { fullName, mtnNumber, loanAmount, months, monthlyIncome, intendedPurpose, status: 'PENDING' });

    // 📋 COMPREHENSIVE TEXT BLOCK TRANSMITTED DOWN TO TELEGRAM CHAT
    const fullMessagePayload = `
📋 *NEW MOPESA UGANDA LOAN APPLICATION*
▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬
👤 *Applicant Name:* \`${fullName}\`
📞 *MTN Wallet Line:* \`${mtnNumber}\`
💰 *Principal Amount:* UGX ${parseFloat(loanAmount).toLocaleString()}
📅 *Horizon Duration:* ${months} Months
📈 *Monthly Income:* UGX ${parseFloat(monthlyIncome).toLocaleString()}
🌾 *Intended Vector:* ${intendedPurpose.toUpperCase()}
🆔 *Application Ref:* \`${applicationId}\`
▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬
*Action Required: Choose an authorization vector below.*
    `;

    // 🔘 THE TELEGRAM INLINE KEYBOARD CORE MATRIX
    const interactiveInlineKeyboard = {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "Approve & Pay ✅", callback_data: `APPROVE_${applicationId}` },
                    { text: "Reject Application ❌", callback_data: `REJECT_${applicationId}` }
                ]
            ]
        },
        parse_mode: 'Markdown'
    };

    try {
        // Broadcast the template down to your private Admin chat ID channel
        await bot.sendMessage(ADMIN_CHAT_ID, fullMessagePayload, interactiveInlineKeyboard);
        return res.status(200).json({ success: true, applicationId });
    } catch (error) {
        console.error("[TELEGRAM BROADCAST REJECTION]:", error.message);
        return res.status(500).json({ success: false, error: "Unable to push data matrix down to administration console." });
    }
});

/**
 * 🎯 INTERACTIVE INLINE KEYBOARD ACTIONS INTERCEPT HOOK
 * This block runs immediately when you click Approve or Reject inside Telegram
 */
bot.on('callback_query', async (callbackQuery) => {
    const actionData = callbackQuery.data;
    const messageContext = callbackQuery.message;

    const isApproval = actionData.startsWith('APPROVE_');
    const isRejection = actionData.startsWith('REJECT_');
    
    // Extract unique tracking sequence string from payload pattern
    const applicationId = actionData.replace('APPROVE_', '').replace('REJECT_', '');
    const application = pendingLoansCache.get(applicationId);

    if (!application || application.status !== 'PENDING') {
        return bot.answerCallbackQuery(callbackQuery.id, { text: "Error: Session context closed or already processed.", show_alert: true });
    }

    if (isRejection) {
        application.status = 'REJECTED';
        pendingLoansCache.set(applicationId, application);

        // Strip action elements and lock state as Rejected to clean up the Telegram screen
        await bot.editMessageText(
            `${messageContext.text}\n\n🛑 *DECISION PROFILE LOG: DECLINED BY ADMINISTRATIVE CONSOLE*`, 
            { chat_id: messageContext.chat.id, message_id: messageContext.message_id, parse_mode: 'Markdown' }
        );
        return bot.answerCallbackQuery(callbackQuery.id, { text: "Application marked as Declined successfully." });
    }

    if (isApproval) {
        // Alert admin immediately inside Telegram screen that work has begun
        await bot.answerCallbackQuery(callbackQuery.id, { text: "Reaching out to MTN API Gateways... Executing Wallet Payout." });

        try {
            // Trigger actual money transfer through momoServer.js logic
            const mtnReceipt = await requestLoanDisbursement(application.mtnNumber, application.loanAmount);

            application.status = 'APPROVED';
            application.mtnTransactionId = mtnReceipt.transactionId;
            pendingLoansCache.set(applicationId, application);

            // Update Telegram layout with immutable validation tx verification strings
            await bot.editMessageText(
                `${messageContext.text}\n\n🟢 *DECISION PROFILE LOG: APPROVED & FUNDS PAID OUT*\n🔗 *MTN Verification TxID:* \`${mtnReceipt.transactionId}\``, 
                { chat_id: messageContext.chat.id, message_id: messageContext.message_id, parse_mode: 'Markdown' }
            );
        } catch (error) {
            console.error("[MTN INFRASTRUCTURE OPERATION BLOCKED]:", error.message);
            await bot.sendMessage(
                messageContext.chat.id, 
                `⚠️ *CRITICAL DISBURSEMENT SYSTEM FAULT FOR ID ${applicationId}:* \n_${error.message}_`, 
                { parse_mode: 'Markdown' }
            );
        }
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 [SERVER UP] Web platform live. Telegram hooks running smoothly on port ${PORT}`);
});

