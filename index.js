require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const usersSession = {};
const orders = {};
const loyaltyPoints = {};

const MENU_ITEMS = {
    "pani_puri": { name: "Pani Puri", variations: { small: 20, large: 35 } },
    "bhel_puri": { name: "Bhel Puri", variations: { regular: 30, spicy: 35 } },
    "sev_puri": { name: "Sev Puri", variations: { regular: 25, extra_cheese: 30 } },
    "dahi_puri": { name: "Dahi Puri", variations: { regular: 35, extra_dahi: 40 } }
};

const WHATSAPP_URL = `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`;

// ✅ Webhook Verification
app.get('/webhook', (req, res) => {
    if (req.query['hub.verify_token'] === process.env.VERIFY_TOKEN) {
        return res.status(200).send(req.query['hub.challenge']);
    }
    res.sendStatus(403);
});

// ✅ Send WhatsApp Message
async function sendMessage(to, text, buttons = []) {
    try {
        if (buttons.length > 3) {
            console.log("⚠️ Too many buttons! Splitting into multiple messages.");
            await sendMessage(to, text, buttons.slice(0, 3)); // Send first 3 buttons
            await sendMessage(to, "➡️ More options:", buttons.slice(3)); // Send remaining buttons
            return;
        }

        const payload = {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to,
            type: buttons.length > 0 ? "interactive" : "text",
            ...(buttons.length > 0 ? {
                interactive: {
                    type: "button",
                    body: { text },
                    action: {
                        buttons: buttons.map(b => ({
                            type: "reply",
                            reply: { id: b.id, title: b.title }
                        }))
                    }
                }
            } : { text: { body: text } })
        };

        console.log("📤 Sending message:", JSON.stringify(payload, null, 2));

        const response = await axios.post(WHATSAPP_URL, payload, {
            headers: {
                Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
                "Content-Type": "application/json"
            }
        });

        console.log("✅ Message sent successfully:", response.data);
    } catch (error) {
        console.error("❌ Error sending message:", error.response?.data || error.message);
    }
}

// ✅ Handle Incoming Messages
app.post('/webhook', async (req, res) => {
    console.log("📩 Incoming Webhook Payload:", JSON.stringify(req.body, null, 2));

    const messages = req.body?.entry?.[0]?.changes?.[0]?.value?.messages;
    if (messages) {
        for (const message of messages) {
            const from = message.from;
            let userInput = "";
            
            if (message.interactive && message.interactive.button_reply) {
                userInput = message.interactive.button_reply.id;
            } else if (message.text) {
                userInput = message.text.body.toLowerCase().trim();
            } else {
                console.log("⚠️ Unrecognized message format");
                return;
            }

            console.log(`📩 Received: ${userInput} from ${from}`);

            if (!usersSession[from]) {
                usersSession[from] = { stage: "start", order: [] };
                await sendMessage(from, "🍽️ Welcome to Puchka Das!", [
                    { id: "menu", title: "Menu" },
                    { id: "cart", title: "View Cart" }
                ]);
                continue;
            }

            if (userInput === "menu") {
                console.log("🛒 Menu button clicked - Sending menu items...");
                
                // ✅ Fix: Limit menu items to 3 per message
                const menuButtons = Object.keys(MENU_ITEMS).map(key => ({
                    id: key, title: MENU_ITEMS[key].name
                }));

                await sendMessage(from, "🌟 Select an item:", menuButtons);
                continue;
            }

            if (MENU_ITEMS[userInput]) {
                usersSession[from].selectedItem = userInput;
                const variations = Object.entries(MENU_ITEMS[userInput].variations).map(([varName, price]) => ({
                    id: `variation_${varName}`, title: `${varName} - ₹${price}`
                }));

                await sendMessage(from, `🛒 Choose variation for ${MENU_ITEMS[userInput].name}:`, variations);
                continue;
            }

            if (userInput.startsWith("variation_")) {
                const variation = userInput.replace("variation_", "");
                const item = usersSession[from].selectedItem;
                if (MENU_ITEMS[item]?.variations[variation]) {
                    usersSession[from].selectedVariation = variation;
                    await sendMessage(from, "🔢 Enter quantity (e.g., 2)");
                } else {
                    await sendMessage(from, "❌ Invalid variation. Try again.");
                }
                continue;
            }

            if (!isNaN(userInput)) {
                const quantity = parseInt(userInput);
                const item = usersSession[from].selectedItem;
                const variation = usersSession[from].selectedVariation;
                if (item && variation && quantity > 0) {
                    const price = MENU_ITEMS[item].variations[variation];
                    usersSession[from].order.push({ name: MENU_ITEMS[item].name, variation, price, quantity });
                    await sendMessage(from, `✅ Added ${quantity}x ${MENU_ITEMS[item].name} (${variation}) to cart.`, [
                        { id: "cart", title: "View Cart" },
                        { id: "checkout", title: "Checkout" }
                    ]);
                } else {
                    await sendMessage(from, "❌ Invalid quantity. Try again.");
                }
                continue;
            }

            if (userInput === "cart") {
                let cartMessage = usersSession[from].order.length > 0 ? "🛒 *Your Cart:*\n" : "🛒 Your cart is empty!";
                let total = 0;
                usersSession[from].order.forEach(item => {
                    cartMessage += `- ${item.quantity}x ${item.name} (${item.variation}) - ₹${item.price * item.quantity}\n`;
                    total += item.price * item.quantity;
                });
                cartMessage += usersSession[from].order.length > 0 ? `\n💰 *Total: ₹${total}*` : "";
                await sendMessage(from, cartMessage, [{ id: "checkout", title: "Checkout" }]);
                continue;
            }

            if (userInput === "checkout") {
                await sendMessage(from, "🎉 Order confirmed! Thank you for shopping!", [{ id: "reset", title: "Start Over" }]);
                delete usersSession[from];
                continue;
            }

            await sendMessage(from, "🤖 Invalid input. Try again.");
        }
    }
    res.sendStatus(200);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
