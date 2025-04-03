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
const adminOrders = []; 
const loyaltyPoints = {}; 

const MENU_ITEMS = {
    1: { name: "Pani Puri", variations: { small: 20, large: 35 } },
    2: { name: "Bhel Puri", variations: { regular: 30, spicy: 35 } },
    3: { name: "Sev Puri", variations: { regular: 25, extra_cheese: 30 } },
    4: { name: "Dahi Puri", variations: { regular: 35, extra_dahi: 40 } }
};

const WHATSAPP_URL = `https://graph.facebook.com/v21.0/${process.env.PHONE_NUMBER_ID}/messages`;

// ✅ GET route for webhook verification
app.get('/webhook', (req, res) => {
    const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token === VERIFY_TOKEN) {
        console.log("✅ Webhook verified successfully!");
        res.status(200).send(challenge);
    } else {
        console.error("❌ Webhook verification failed. Invalid token.");
        res.sendStatus(403);
    }
});

async function sendMessage(to, message, buttons = []) {
    try {
        let payload = {
            messaging_product: "whatsapp",
            to,
            type: buttons.length > 0 ? "interactive" : "text",
            ...(buttons.length > 0
                ? {
                    interactive: {
                        type: "button",
                        body: { text: message },
                        action: { buttons: buttons.map(label => ({ type: "reply", reply: { id: label.toLowerCase().replace(/\s/g, "_"), title: label } })) }
                    }
                }
                : { text: { body: message } })
        };

        await axios.post(WHATSAPP_URL, payload, {
            headers: {
                Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
                "Content-Type": "application/json"
            }
        });
    } catch (error) {
        console.error("❌ Error sending message:", error.response?.data || error.message);
    }
}

app.post('/webhook', async (req, res) => {
    const messageData = req.body;

    if (messageData.object) {
        const messages = messageData.entry?.[0]?.changes?.[0]?.value?.messages;
        if (messages) {
            for (const message of messages) {
                const from = message.from;
                const text = message.text?.body?.toLowerCase().trim();
                const buttonId = message.interactive?.button_reply?.id;
                const userInput = buttonId || text;

                console.log(`📩 Received message: ${userInput} from ${from}`);

                if (userInput === "reset") {
                    delete usersSession[from];
                    await sendMessage(from, "🔄 Order reset. Starting fresh!", ["Menu", "Cart", "Loyalty Points"]);
                    continue;
                }

                if (!usersSession[from]) {
                    usersSession[from] = { stage: "greeting", order: [] };
                    await sendMessage(from, "🌟 Welcome to Puchka Das! 🌟", ["Menu", "Cart", "Loyalty Points", "Reset"]);
                    continue;
                }

                if (userInput === "menu") {
                    usersSession[from].stage = "choosing_item";
                    const menuButtons = Object.entries(MENU_ITEMS).map(([id, item]) => ({
                        id: `item_${id}`,
                        title: item.name
                    }));
                    await sendMessage(from, "🍽️ Choose an item:", [...menuButtons, { id: "reset", title: "Reset" }]);
                    continue;
                }

                if (userInput.startsWith("item_")) {
                    const itemId = userInput.split("_")[1];
                    if (MENU_ITEMS[itemId]) {
                        usersSession[from].selectedItem = itemId;
                        usersSession[from].stage = "choosing_variation";

                        const variations = Object.entries(MENU_ITEMS[itemId].variations).map(([variation, price]) => ({
                            id: `variation_${variation}`,
                            title: `${variation} - ₹${price}`
                        }));
                        await sendMessage(from, `🛒 Choose a variation for *${MENU_ITEMS[itemId].name}*:`, [...variations, { id: "reset", title: "Reset" }]);
                    } else {
                        await sendMessage(from, "❌ Invalid selection. Please choose again.");
                    }
                    continue;
                }

                if (userInput.startsWith("variation_")) {
                    const variation = userInput.split("_")[1];
                    const itemId = usersSession[from]?.selectedItem;

                    if (itemId && MENU_ITEMS[itemId].variations[variation]) {
                        usersSession[from].selectedVariation = variation;
                        usersSession[from].stage = "choosing_quantity";
                        await sendMessage(from, "🔢 Enter quantity (e.g., 2 for 2 pieces)");
                    } else {
                        await sendMessage(from, "❌ Invalid variation. Please select again.");
                    }
                    continue;
                }

                if (usersSession[from].stage === "choosing_quantity" && !isNaN(userInput)) {
                    const quantity = parseInt(userInput);
                    const itemId = usersSession[from]?.selectedItem;
                    const variation = usersSession[from]?.selectedVariation;

                    if (itemId && variation && quantity > 0) {
                        const price = MENU_ITEMS[itemId].variations[variation];
                        usersSession[from].order.push({
                            name: MENU_ITEMS[itemId].name,
                            variation,
                            price,
                            quantity
                        });

                        usersSession[from].stage = "ordering";
                        delete usersSession[from].selectedItem;
                        delete usersSession[from].selectedVariation;

                        await sendMessage(from, `✅ Added ${quantity}x ${MENU_ITEMS[itemId].name} (${variation}) to cart.`, ["View Cart", "Checkout", "Reset"]);
                    } else {
                        await sendMessage(from, "❌ Invalid quantity. Please enter a number.");
                    }
                    continue;
                }

                if (userInput === "cart") {
                    let cartMessage = "🛒 *Your Cart:*\n";
                    let total = 0;
                    usersSession[from].order.forEach(item => {
                        cartMessage += `- ${item.quantity}x ${item.name} (${item.variation}) - ₹${item.price * item.quantity}\n`;
                        total += item.price * item.quantity;
                    });
                    cartMessage += `\n💰 *Total: ₹${total}*`;
                    await sendMessage(from, cartMessage, ["Confirm Order", "Modify Order", "Reset"]);
                    continue;
                }

                if (userInput === "checkout") {
                    if (usersSession[from].order.length === 0) {
                        await sendMessage(from, "🛒 Your cart is empty!");
                        continue;
                    }
                    let totalAmount = 0;
                    let summary = "🛒 *Order Summary:*\n";
                    usersSession[from].order.forEach(item => {
                        summary += `- ${item.quantity}x ${item.name} (${item.variation}) - ₹${item.price * item.quantity}\n`;
                        totalAmount += item.price * item.quantity;
                    });
                    summary += `\n💰 *Total: ₹${totalAmount}*\n✅ Confirm order?`;
                    await sendMessage(from, summary, ["Confirm", "Cancel", "Reset"]);
                    continue;
                }

                if (userInput === "confirm") {
                    orders[from] = usersSession[from].order;
                    adminOrders.push({ user: from, order: usersSession[from].order });

                    loyaltyPoints[from] = (loyaltyPoints[from] || 0) + 10; 
                    await sendMessage(from, "🎉 Order confirmed! You earned *10 loyalty points*! 🍽️", ["Track Order", "Reset"]);
                    delete usersSession[from];
                    continue;
                }

                await sendMessage(from, "🤖 I didn't understand. Type *menu* to see options.", ["Menu", "Cart", "Reset"]);
            }
        }
    }
    res.sendStatus(200);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 WhatsApp bot running on port ${PORT}`));
