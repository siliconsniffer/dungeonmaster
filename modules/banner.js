const config = require("../config.json");
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const fs = require('fs/promises');

const queue = new Map();
const channel = config.module_banner.channel;
const threshold = config.module_banner.threshold;
const interval = config.module_banner.interval;
const emojis = config.module_banner.emojis

function getGuild(client) {
    return client.guilds.fetch(config.guild);
}

// Function to set the icon (e.g., for a guild/server)
async function setNextIcon(guild, client) {
    console.info('[setNextIcon] Called. Queue size:', queue.size);
    if (queue.size === 0) {
        console.log('[setNextIcon] Queue is empty, nothing to process.');
        return;
    }
    const [key, value] = queue.entries().next().value; // Get the first entry
    console.log('[setNextIcon] Next icon candidate:', { key, value });
    try {
        if (!value || !value.url) {
            console.log('[setNextIcon] No valid value or url for icon.');
            return;
        }
        console.log('[setNextIcon] Attempting to set guild icon to:', value.url);
        await guild.setIcon(value.url); // Set the guild's icon
        console.log('[setNextIcon] Icon updated:', value.url);
        queue.delete(key); // Remove the entry after updating
        writeQueue();

        // Send a message to the channel when the icon is updated
        if (channel) {
            channel.send(`Server icon updated! New image: ${value.url}`);
        } else {
            console.warn('[setNextIcon] Could not find channel to send update message.');
        }
    } catch (error) {
        console.error('[setNextIcon] Failed to set icon:', error);
    }
}

function startIconInterval(client) {
    console.log('[startIconInterval] Starting icon update interval...');
    getGuild(client).then(guild => {
        console.log('[startIconInterval] Guild fetched for icon updates:', guild.id);
        setInterval(() => {
            console.log('[startIconInterval] Interval fired. Checking queue and attempting icon update...');
            printQueue();
            setNextIcon(guild, client);
        }, interval * 1000);
    }).catch(error => {
        console.error('[startIconInterval] Error fetching guild:', error);
    });
}

async function readQueue() {
    try {
        const data = await fs.readFile('queue.json', 'utf8');
        if (data) {
            // Parse the JSON data
            const parsedData = JSON.parse(data);
            // Convert the parsed data back to a Map
            parsedData.forEach(([key, value]) => {
                queue.set(key, value);
            });
            console.log('Queue loaded from queue.json');
        }
    } catch (err) {
        // It's okay if the file doesn't exist on first run
        if (err.code !== 'ENOENT') {
            console.error('Error reading file', err);
        }
    }
}
let writing = false;
let pending = false;

async function writeQueue() {
    if (writing) {
        pending = true;
        return;
    }
    writing = true;
    const json = JSON.stringify(Array.from(queue.entries()), null, 2);
    try {
        await fs.writeFile('queue.json', json);
        console.log('Queue saved to queue.json');
    } catch (err) {
        console.error('Error writing to file', err);
    } finally {
        writing = false;
        if (pending) {
            pending = false;
            // Optionally, call with the latest queue
            writeQueue();
        }
    }
}

function printQueue() {
    console.log("Queue:");
    queue.forEach((value, key) => {
        console.log(`Key: ${key}, Values: ${JSON.stringify(value)}`);
    });
}

function addToQueue(message) {
    // Check if the key already exists in the Map
    if (queue.has(message.id)) {
        console.log(`Key ${message.id} already exists in queue`);
        return;
    }
    // Add the message to the Map
    queue.set(message.id, message);
    console.log(`Added ${message.id} to queue`);
    writeQueue();
}

function removeFromQueue(messageId) {
    // Check if the key exists in the Map
    if (queue.has(messageId)) {
        queue.delete(messageId); // Remove the entry from the Map
        console.log(`Removed ${messageId} from queue`);
        writeQueue();
    }
}

module.exports = (client) => {
    client.on('ready', () => {
        readQueue();
        startIconInterval(client);
    });

    client.on('messageCreate', message => {
        if (!message.guild) return; // Ignore DMs
        if (message.author.bot) return; // Ignore bot messages
        if (message.attachments.size > 0 || message.embeds.length > 0) {
            console.log(`Attachments or embeds found in message`);
        }
    });

    client.on('messageReactionAdd', async (reaction, user) => {
        if (user.bot) return; // Ignore bot reactions

        try {
            if (reaction.partial) await reaction.fetch();
            if (reaction.message.partial) await reaction.message.fetch();

            const emojiName = reaction.emoji.name;
            if (!emojis.includes(emojiName)) return;

            const attachments = Array.from(reaction.message.attachments.values());
            const emojiIndex = emojis.indexOf(emojiName);

            if (attachments.length > 0 && reaction.count >= threshold) {
                const attachmentUrl = attachments[emojiIndex]?.url;
                if (attachmentUrl) {
                    addToQueue({ id: reaction.message.id, url: attachmentUrl });
                    printQueue();
                }
            }
        } catch (error) {
            console.error('Error fetching reaction or message:', error);
        }
    });

    client.on('messageReactionRemove', async (reaction, user) => {
        if (user.bot) return; // Ignore bot reactions

        try {
            if (reaction.partial) await reaction.fetch();
            if (reaction.message.partial) await reaction.message.fetch();

            const emojiName = reaction.emoji.name;
            if (!emojis.includes(emojiName)) return;

            if (reaction.count < threshold) {
                removeFromQueue(reaction.message.id);
                printQueue();
            }
        } catch (error) {
            console.error(error);
        }
    });

    return {
        commands: [
            [
                new SlashCommandBuilder()
                    .setName("queue")
                    .setDescription("Print the banner queue")
                    .setDefaultMemberPermissions(0),
                async (interaction) => {
                    printQueue();
                    for (const [key, value] of queue.entries()) {
                        channel.send(`Key: ${key}, Values: ${JSON.stringify(value)}`);
                    }
                    await interaction.reply({
                        content: `Queue printed to console`,
                        flags: MessageFlags.Ephemeral,
                    });
                }
            ],
            [
                new SlashCommandBuilder()
                    .setName("skip")
                    .setDescription("Force update the banner")
                    .setDefaultMemberPermissions(0),
                async (interaction) => {
                    const guild = await getGuild(client);
                    await setNextIcon(guild, client);
                    await interaction.reply({
                        content: `Banner update attempted`,
                        flags: MessageFlags.Ephemeral,
                    });
                }
            ],
            [
                new SlashCommandBuilder()
                    .setName("rm")
                    .setDescription("Remove an entry from the queue")
                    .setDefaultMemberPermissions(0)
                    .addStringOption(option =>
                        option.setName('messageid')
                            .setDescription('The ID of the message to fetch')
                            .setRequired(true)
                    ),
                async (interaction) => {
                    const messageId = interaction.options.getString('messageid');
                    removeFromQueue(messageId);
                    await interaction.reply({
                        content: `Removed from queue`,
                        flags: MessageFlags.Ephemeral,
                    });
                }
            ],
            [
                new SlashCommandBuilder()
                    .setName("chbanner")
                    .setDescription("Change the banner immediately")
                    .setDefaultMemberPermissions(0)
                    .addStringOption(option =>
                        option.setName('url')
                            .setDescription('The URL of the new banner image')
                            .setRequired(true)
                    ),
                async (interaction) => {
                    const url = interaction.options.getString('url');
                    try {
                        const guild = await getGuild(client);
                        await guild.setBanner(url);
                        await interaction.reply({
                            content: `Banner updated successfully!`,
                            flags: MessageFlags.Ephemeral,
                        });
                    } catch (error) {
                        console.error('Error setting banner:', error);
                        await interaction.reply({
                            content: `Failed to update banner: ${error.message}`,
                            flags: MessageFlags.Ephemeral,
                        });
                    }
                }
            ],
            [
                new SlashCommandBuilder()
                    .setName("reorder")
                    .setDescription("Reorder the queue")
                    .setDefaultMemberPermissions(0)
                    .addStringOption(option =>
                        option.setName('order')
                            .setDescription('Swap two message IDs, comma separated')
                            .setRequired(true)
                    ),
                async (interaction) => {
                    const order = interaction.options.getString('order').split(',');
                    if (order.length !== 2) {
                        return interaction.reply({
                            content: `Please provide exactly two message IDs, comma separated.`,
                            flags: MessageFlags.Ephemeral,
                        });
                    }
                    const [id1, id2] = order;
                    if (!queue.has(id1) || !queue.has(id2)) {
                        return interaction.reply({
                            content: `One or both message IDs not found in queue.`,
                            flags: MessageFlags.Ephemeral,
                        });
                    }
                    const entries = Array.from(queue.entries());
                    const index1 = entries.findIndex(([key]) => key === id1);
                    const index2 = entries.findIndex(([key]) => key === id2);
                    if (index1 === -1 || index2 === -1) {
                        return interaction.reply({
                            content: `One or both message IDs not found in queue.`,
                            flags: MessageFlags.Ephemeral,
                        });
                    }
                    // Swap the entries
                    [entries[index1], entries[index2]] = [entries[index2], entries[index1]];
                    // Rebuild the queue Map
                    queue.clear();
                    for (const [key, value] of entries) {
                        queue.set(key, value);
                    }
                    writeQueue();
                    await interaction.reply({
                        content: `Queue reordered.`,
                        flags: MessageFlags.Ephemeral,
                    });
                }
            ]
        ]
    };
};
