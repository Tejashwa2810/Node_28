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

async function sendMessage(to, message, buttons = []) {
    try {
        let payload = {
            messaging_product: "whatsapp",
            to,
            type: buttons.length > 0 ? "interactive" : "text",
            interactive: buttons.length > 0
                ? {
                    type: "button",
                    body: { text: message },
                    action: { buttons: buttons.map(label => ({ type: "reply", reply: { id: label.toLowerCase(), title: label } })) }
                }
                : { text: message }
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

                if (!usersSession[from]) {
                    usersSession[from] = { stage: "greeting", order: [] };
                    await sendMessage(from, "🌟 Welcome to Puchka Das! 🌟", ["Menu", "Cart", "Loyalty Points"]);
                    continue;
                }

                if (userInput === "menu") {
                    usersSession[from].stage = "choosing_item";
                    const menuButtons = Object.keys(MENU_ITEMS).map(id => ({
                        id: `item_${id}`,
                        title: MENU_ITEMS[id].name
                    }));
                    await sendMessage(from, "🍽️ Choose an item:", menuButtons);
                    continue;
                }

                if (userInput.startsWith("item_")) {
                    const itemId = userInput.split("_")[1];
                    if (MENU_ITEMS[itemId]) {
                        usersSession[from].selectedItem = itemId;
                        usersSession[from].stage = "choosing_variation";

                        const variations = Object.keys(MENU_ITEMS[itemId].variations).map(variation => ({
                            id: `variation_${variation}`,
                            title: variation
                        }));
                        await sendMessage(from, `🛒 Choose a variation for *${MENU_ITEMS[itemId].name}*:`, variations);
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

                        await sendMessage(from, `✅ Added ${quantity}x ${MENU_ITEMS[itemId].name} (${variation}) to cart.`, ["View Cart", "Checkout"]);
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
                    await sendMessage(from, cartMessage, ["Confirm Order", "Modify Order"]);
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
                    await sendMessage(from, summary, ["Confirm", "Cancel"]);
                    continue;
                }

                if (userInput === "confirm") {
                    orders[from] = usersSession[from].order;
                    adminOrders.push({ user: from, order: usersSession[from].order });

                    loyaltyPoints[from] = (loyaltyPoints[from] || 0) + 10; 
                    await sendMessage(from, "🎉 Order confirmed! You earned *10 loyalty points*! 🍽️", ["Track Order"]);
                    delete usersSession[from];
                    continue;
                }

                await sendMessage(from, "🤖 I didn't understand. Type *menu* to see options.", ["Menu", "Cart"]);
            }
        }
    }
    res.sendStatus(200);
});

app.listen(3001, () => console.log("🚀 WhatsApp bot running on port 3001"));
