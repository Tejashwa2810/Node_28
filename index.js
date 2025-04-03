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
const adminOrders = [];

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
        console.log("✅ Webhook verified!");
        res.status(200).send(req.query['hub.challenge']);
    } else {
        res.sendStatus(403);
    }
});

// ✅ Send WhatsApp Message
async function sendMessage(to, text, buttons = []) {
    try {
        const payload = {
            messaging_product: "whatsapp",
            to,
            type: buttons.length > 0 ? "interactive" : "text",
            ...(buttons.length > 0 ? {
                interactive: {
                    type: "button",
                    body: { text },
                    action: { buttons: buttons.map(b => ({ type: "reply", reply: { id: b.id, title: b.title } })) }
                }
            } : { text: { body: text } })
        };

        const response = await axios.post(WHATSAPP_URL, payload, {
            headers: {
                Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
                "Content-Type": "application/json"
            }
        });

        console.log("✅ Message sent:", response.data);
    } catch (error) {
        console.error("❌ Error sending message:", error.response?.data || error.message);
    }
}

// ✅ Handle Incoming Messages
app.post('/webhook', async (req, res) => {
    const messages = req.body?.entry?.[0]?.changes?.[0]?.value?.messages;
    if (messages) {
        for (const message of messages) {
            const from = message.from;
            const text = message.text?.body?.toLowerCase().trim();
            const buttonId = message.interactive?.button_reply?.id;
            const userInput = buttonId || text;

            console.log(`📩 Received: ${userInput} from ${from}`);

            if (userInput === "reset") {
                delete usersSession[from];
                await sendMessage(from, "🔄 Reset successful!", [{ id: "menu", title: "Menu" }]);
                continue;
            }

            if (!usersSession[from]) {
                usersSession[from] = { stage: "start", order: [] };
                await sendMessage(from, "🍽️ Welcome to Puchka Das!", [
                    { id: "menu", title: "Menu" },
                    { id: "cart", title: "View Cart" },
                    { id: "loyalty", title: "Loyalty Points" }
                ]);
                continue;
            }

            if (userInput === "menu") {
                usersSession[from].stage = "choosing_item";
                await sendMessage(from, "🌟 Select an item:", Object.keys(MENU_ITEMS).map(key => ({
                    id: key, title: MENU_ITEMS[key].name
                })));
                continue;
            }

            if (MENU_ITEMS[userInput]) {
                usersSession[from].selectedItem = userInput;
                usersSession[from].stage = "choosing_variation";

                await sendMessage(from, `🛒 Choose variation for ${MENU_ITEMS[userInput].name}:`, Object.entries(MENU_ITEMS[userInput].variations).map(([varName, price]) => ({
                    id: `variation_${varName}`, title: `${varName} - ₹${price}`
                })));
                continue;
            }

            if (userInput.startsWith("variation_")) {
                const variation = userInput.replace("variation_", "");
                const item = usersSession[from].selectedItem;

                if (item && MENU_ITEMS[item].variations[variation]) {
                    usersSession[from].selectedVariation = variation;
                    usersSession[from].stage = "choosing_quantity";
                    await sendMessage(from, "🔢 Enter quantity (e.g., 2)");
                } else {
                    await sendMessage(from, "❌ Invalid variation. Try again.");
                }
                continue;
            }

            if (usersSession[from].stage === "choosing_quantity" && !isNaN(userInput)) {
                const quantity = parseInt(userInput);
                const item = usersSession[from].selectedItem;
                const variation = usersSession[from].selectedVariation;

                if (item && variation && quantity > 0) {
                    const price = MENU_ITEMS[item].variations[variation];
                    usersSession[from].order.push({ name: MENU_ITEMS[item].name, variation, price, quantity });

                    usersSession[from].stage = "ordering";
                    delete usersSession[from].selectedItem;
                    delete usersSession[from].selectedVariation;

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
                if (!usersSession[from].order.length) {
                    await sendMessage(from, "🛒 Your cart is empty!");
                    continue;
                }

                let cartMessage = "🛒 *Your Cart:*\n";
                let total = 0;
                usersSession[from].order.forEach(item => {
                    cartMessage += `- ${item.quantity}x ${item.name} (${item.variation}) - ₹${item.price * item.quantity}\n`;
                    total += item.price * item.quantity;
                });

                cartMessage += `\n💰 *Total: ₹${total}*`;
                await sendMessage(from, cartMessage, [{ id: "checkout", title: "Checkout" }]);
                continue;
            }

            if (userInput === "checkout") {
                if (!usersSession[from].order.length) {
                    await sendMessage(from, "🛒 Your cart is empty!");
                    continue;
                }

                let totalAmount = usersSession[from].order.reduce((sum, item) => sum + item.price * item.quantity, 0);
                let orderSummary = "🛒 *Order Summary:*\n" + usersSession[from].order.map(item => 
                    `- ${item.quantity}x ${item.name} (${item.variation}) - ₹${item.price * item.quantity}`
                ).join("\n") + `\n\n💰 *Total: ₹${totalAmount}*\n✅ Confirm order?`;

                await sendMessage(from, orderSummary, [
                    { id: "confirm", title: "Confirm Order" },
                    { id: "reset", title: "Reset Order" }
                ]);
                continue;
            }

            if (userInput === "confirm") {
                orders[from] = usersSession[from].order;
                adminOrders.push({ user: from, order: usersSession[from].order });
                loyaltyPoints[from] = (loyaltyPoints[from] || 0) + 10;

                await sendMessage(from, "🎉 Order confirmed! You earned *10 loyalty points*!", [{ id: "reset", title: "Reset" }]);
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
