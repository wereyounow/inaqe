const { Client, GatewayIntentBits, EmbedBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ActivityType, SlashCommandBuilder, REST, Routes } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ========== Settings ==========
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
];

// ========== Tokens ==========
const TOKEN_PINTEREST ='MTUxYwNTQ0NTc2Mw.GZLsV7.TmMez-Men5oGtBTzqmFjouljcAg2jXG_GCjhiw';
const CLIENT_ID       = process.env.CLIENT_ID || '1515303677605445763';

if (!TOKEN_PINTEREST) {
    console.error('❌ TOKEN_PINTEREST must be set in environment variables');
    process.exit(1);
}

// ========== Channel IDs ==========
const PINTEREST_CHANNEL_ID = '1519470579508445194';

// ========== Developer IDs (only these users can use slash commands) ==========
const DEVELOPER_IDS = ['1384688131374317598','1471245404501839966'];

// ========== Image Settings ==========
const DEFAULT_KEYWORDS = ['chainsawman icon','chainsawan aki Icon'];
const PINTEREST_CHANGE_INTERVAL = 300;

const AVATARS_DIR = path.join(__dirname, 'avatars');
if (!fs.existsSync(AVATARS_DIR)) fs.mkdirSync(AVATARS_DIR, { recursive: true });

// ========== State ==========
const STATE_FILE        = path.join(__dirname, 'avatar_state.json');
const STATE_BACKUP_FILE = STATE_FILE + '.backup';
const IMAGE_CACHE_MAX   = 100;

let PinterestimageCache = [];
let keywords            = [...DEFAULT_KEYWORDS]; // dynamic keywords list
let keywordMode         = 'random';              // 'random' | 'sequential'
let _keywordIndex       = 0;

function loadCache() {
    for (const file of [STATE_FILE, STATE_BACKUP_FILE]) {
        try {
            if (fs.existsSync(file)) {
                const data = JSON.parse(fs.readFileSync(file, 'utf8'));
                PinterestimageCache = data.PinterestimageCache ?? [];
                keywords            = data.keywords            ?? [...DEFAULT_KEYWORDS];
                keywordMode         = data.keywordMode         ?? 'random';
                _keywordIndex       = data.keywordIndex        ?? 0;
                console.log(`📂 State loaded | Cache: ${PinterestimageCache.length} | Keywords: ${keywords.length} | Mode: ${keywordMode}`);
                return;
            }
        } catch (err) {
            console.warn(`⚠️ Could not read ${path.basename(file)}: ${err.message}`);
        }
    }
    keywords = [...DEFAULT_KEYWORDS];
    saveCache();
    console.log('📂 New state file created');
}

function saveCache() {
    try {
        const data = JSON.stringify({ PinterestimageCache, keywords, keywordMode, keywordIndex: _keywordIndex }, null, 2);
        if (fs.existsSync(STATE_FILE)) fs.copyFileSync(STATE_FILE, STATE_BACKUP_FILE);
        fs.writeFileSync(STATE_FILE, data, 'utf8');
    } catch (err) {
        console.error(`❌ Error saving state: ${err.message}`);
    }
}

// ========== Graceful Shutdown ==========
process.on('SIGTERM', () => { saveCache(); process.exit(0); });
process.on('SIGINT',  () => { saveCache(); process.exit(0); });

// ========== Bot Instance ==========
const pinterestBot = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
    ]
});

// ========== Utility ==========
async function withRetry(fn, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (i === maxRetries - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 1000));
        }
    }
}

function getImageFormat(url, buffer = null) {
    if (buffer && buffer.length > 3) {
        if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'gif';
        if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'png';
        if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'jpg';
        if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return 'webp';
    }
    if (url) {
        const ext = url.split('.').pop().toLowerCase().split('?')[0];
        if (['gif', 'png', 'jpg', 'jpeg', 'webp'].includes(ext)) return ext === 'jpeg' ? 'jpg' : ext;
    }
    return 'png';
}

function pickFreshUrl(urls) {
    const fresh = urls.filter(u => !PinterestimageCache.includes(u));
    const pool  = fresh.length > 0 ? fresh : urls;
    const url   = pool[Math.floor(Math.random() * pool.length)];
    PinterestimageCache.push(url);
    if (PinterestimageCache.length > IMAGE_CACHE_MAX) PinterestimageCache.shift();
    saveCache();
    return { url, wasFresh: fresh.length > 0 };
}

function pickKeyword() {
    if (keywords.length === 0) return DEFAULT_KEYWORDS[0];
    if (keywordMode === 'sequential') {
        const kw = keywords[_keywordIndex % keywords.length];
        _keywordIndex++;
        return kw;
    }
    return keywords[Math.floor(Math.random() * keywords.length)];
}

// ========== Pinterest API ==========
async function searchPinterest(keyword) {
    console.log(`📌 Pinterest search: "${keyword}"`);
    const source_url = `/search/pins/?q=${encodeURIComponent(keyword)}&rs=typed`;
    const data = JSON.stringify({
        options: {
            query: keyword,
            scope: 'pins',
            page_size: 25,
            bookmarks: [],
            article: '',
            appliedProductFilters: '---',
            price_max: null,
            price_min: null,
            auto_correction_disabled: '',
            top_pin_id: '',
            filters: ''
        },
        context: {}
    });
    const url = `https://www.pinterest.com/resource/BaseSearchResource/get/?source_url=${encodeURIComponent(source_url)}&data=${encodeURIComponent(data)}`;

    const res = await axios.get(url, {
        timeout: 15000,
        headers: {
            'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'Accept-Language': 'en-US,en;q=0.9',
            'X-Requested-With': 'XMLHttpRequest',
            'x-pinterest-pws-handler': 'www/search/[scope].js',
            'Referer': `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(keyword)}`
        }
    });

    const results = res.data?.resource_response?.data?.results ?? [];
    const urls = results
        .map(r => r?.images?.orig?.url)
        .filter(u => u?.startsWith('http'));

    console.log(`✅ Pinterest API: ${urls.length} images found`);
    return urls;
}

async function downloadImage(url, filepath) {
    return withRetry(async () => {
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'arraybuffer',
            headers: { 'Accept': 'image/png,image/gif,image/jpeg,image/webp,*/*' },
            timeout: 30000
        });
        const buffer = Buffer.from(response.data);
        const format = getImageFormat(url, buffer);
        const finalPath = filepath.replace(/\.\w+$/, `.${format}`);
        fs.writeFileSync(finalPath, buffer);
        return { path: finalPath, format, buffer, size: buffer.length };
    }, 3);
}

// ========== Image Update ==========
async function updatePinterestAvatar() {
    console.log(`\n🔄 [${new Date().toLocaleString()}] Updating...`);

    try {
        const keyword = pickKeyword();
        const urls    = await withRetry(() => searchPinterest(keyword), 3);

        if (!urls || urls.length === 0) {
            console.error('❌ No images found from Pinterest');
            return;
        }

        const { url, wasFresh } = pickFreshUrl(urls);
        console.log(`🖼️ Image (${wasFresh ? 'fresh' : 'from cache'}) | cache: ${PinterestimageCache.length}/${IMAGE_CACHE_MAX}`);
        console.log(`🔗 ${url}`);

        const timestamp = Date.now();
        const filepath  = path.join(AVATARS_DIR, `anime_${timestamp}.jpg`);
        const result    = await downloadImage(url, filepath);

        if (result.size < 1000) {
            console.warn('⚠️ Image too small, skipping');
            fs.unlinkSync(result.path);
            return;
        }

        console.log(`📦 ${(result.size / 1024).toFixed(2)}KB | ${result.format.toUpperCase()}`);

        let channel = pinterestBot.channels.cache.get(PINTEREST_CHANNEL_ID);
        if (!channel) {
            console.log('🔍 Channel not in cache, fetching...');
            try { channel = await pinterestBot.channels.fetch(PINTEREST_CHANNEL_ID); }
            catch (err) { console.error(`❌ Could not access channel: ${err.message}`); }
        }

        if (channel) {
            const imgName = `anime.${result.format}`;
            const sent = await channel.send({
                embeds: [new EmbedBuilder()
                    .setTitle('Avatar — Pinterest')
                    .setDescription(`🔍 \`${keyword}\``)
                    .setImage(`attachment://${imgName}`)
                    .setColor('#E60023')
                ],
                files: [new AttachmentBuilder(result.buffer, { name: imgName })]
            });

            const att = sent.attachments.find(a => a.name === imgName);
            if (att) {
                await sent.edit({
                    embeds: [new EmbedBuilder()
                        .setTitle('Avatar — Pinterest')
                        .setDescription(`🔍 \`${keyword}\``)
                        .setURL(att.url)
                        .setImage(`attachment://${imgName}`)
                        .setColor('#E60023')
                    ],
                    components: [new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setLabel('🖼️ Image').setURL(att.url).setStyle(ButtonStyle.Link)
                    )]
                });
            }
            console.log('✅ Embed sent with permanent link');
        } else {
            console.error('❌ Channel not found — check PINTEREST_CHANNEL_ID or bot permissions');
        }

        setTimeout(() => { try { fs.unlinkSync(result.path); } catch {} }, 5000);

    } catch (err) {
        console.error(`❌ updatePinterestAvatar failed: ${err.message}`);
    }
}

// ========== Slash Commands ==========
async function registerSlashCommands() {
    const rest = new REST({ version: '10' }).setToken(TOKEN_PINTEREST);
    try {
        await rest.put(Routes.applicationCommands(CLIENT_ID), {
            body: [
                new SlashCommandBuilder()
                    .setName('mode')
                    .setDescription('Toggle keyword selection mode between random and sequential'),

                new SlashCommandBuilder()
                    .setName('addkeyword')
                    .setDescription('Add a new search keyword to the Pinterest list')
                    .addStringOption(opt => opt
                        .setName('keyword')
                        .setDescription('The keyword to add (e.g. "demon slayer icon")')
                        .setRequired(true)
                    ),

                new SlashCommandBuilder()
                    .setName('keywords')
                    .setDescription('Show all current keywords and the active mode'),

                new SlashCommandBuilder()
                    .setName('removekeyword')
                    .setDescription('Remove a keyword from the Pinterest list by its number')
                    .addIntegerOption(opt => opt
                        .setName('number')
                        .setDescription('The keyword number shown in /keywords')
                        .setRequired(true)
                        .setMinValue(1)
                    ),
            ]
        });
        console.log('✅ Slash commands registered');
    } catch (err) {
        console.error(`❌ Command registration failed: ${err.message}`);
    }
}

// ========== Error Reply Helper ==========
async function replyError(interaction, now, description) {
    const payload = {
        embeds: [new EmbedBuilder()
            .setColor('#ED4245')
            .setAuthor({ name: 'Pinterest Bot — Unexpected Error', iconURL: interaction.client.user.displayAvatarURL() })
            .setTitle('⚙️  Something went wrong')
            .setDescription(description)
            .setFooter({ text: `Requested by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL({ dynamic: true }) })
            .setTimestamp(now)
        ],
        ephemeral: true
    };
    try {
        if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
        else await interaction.reply(payload);
    } catch {}
}

// ========== Interaction Handler ==========
pinterestBot.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand()) return;

    if (!DEVELOPER_IDS.includes(interaction.user.id)) {
        return interaction.reply({
            embeds: [new EmbedBuilder()
                .setColor('#ED4245')
                .setAuthor({ name: 'Pinterest Bot — Access Denied', iconURL: interaction.client.user.displayAvatarURL() })
                .setTitle('🔒  Unauthorized')
                .setDescription('This command is restricted to **bot developers** only.')
                .setFooter({ text: `Requested by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL({ dynamic: true }) })
                .setTimestamp()
            ],
            ephemeral: true
        });
    }

    const now = new Date();

    // ── /mode ──────────────────────────────────────────────
    if (interaction.commandName === 'mode') { try {
        keywordMode = keywordMode === 'random' ? 'sequential' : 'random';
        if (keywordMode === 'sequential') _keywordIndex = 0;
        saveCache();

        const isRandom   = keywordMode === 'random';
        const modeColor  = isRandom ? '#5865F2' : '#57F287';
        const modeEmoji  = isRandom ? '🎲' : '🔁';
        const modeLabel  = isRandom ? 'Random' : 'Sequential';
        const modeDesc   = isRandom
            ? 'A keyword is picked **at random** every update.'
            : 'Keywords rotate **in order** every update.';
        const kwList = keywords.map((k, i) => `> \`${String(i + 1).padStart(2, '0')}.\` ${k}`).join('\n') || '> *No keywords set*';

        await interaction.reply({
            embeds: [new EmbedBuilder()
                .setColor(modeColor)
                .setAuthor({ name: 'Pinterest Bot — Mode Changed', iconURL: interaction.client.user.displayAvatarURL() })
                .setTitle(`${modeEmoji}  Switched to ${modeLabel} mode`)
                .setDescription(modeDesc)
                .addFields(
                    { name: '─────────────────', value: kwList },
                    { name: '\u200b', value: `**${keywords.length}** keyword${keywords.length !== 1 ? 's' : ''} total`, inline: true }
                )
                .setFooter({ text: `Requested by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL({ dynamic: true }) })
                .setTimestamp(now)
            ],
            ephemeral: true
        });
    } catch (err) { console.error(`❌ /mode error: ${err.message}`); await replyError(interaction, now, `\`${err.message}\``); } }

    // ── /addkeyword ────────────────────────────────────────
    else if (interaction.commandName === 'addkeyword') { try {
        const kw = interaction.options.getString('keyword').trim();

        if (keywords.includes(kw)) {
            return interaction.reply({
                embeds: [new EmbedBuilder()
                    .setColor('#FEE75C')
                    .setAuthor({ name: 'Pinterest Bot — Duplicate', iconURL: interaction.client.user.displayAvatarURL() })
                    .setTitle('⚠️  Keyword already exists')
                    .setDescription(`\`${kw}\` is already in the list — no changes made.`)
                    .setFooter({ text: `Requested by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL({ dynamic: true }) })
                    .setTimestamp(now)
                ],
                ephemeral: true
            });
        }

        keywords.push(kw);
        saveCache();

        const modeEmoji = keywordMode === 'random' ? '🎲' : '🔁';
        const kwList    = keywords.map((k, i) => `> \`${String(i + 1).padStart(2, '0')}.\` ${k}${k === kw ? '  ← **new**' : ''}`).join('\n');

        await interaction.reply({
            embeds: [new EmbedBuilder()
                .setColor('#57F287')
                .setAuthor({ name: 'Pinterest Bot — Keyword Added', iconURL: interaction.client.user.displayAvatarURL() })
                .setTitle('✅  New keyword saved')
                .addFields(
                    { name: '🆕  Added',         value: `\`${kw}\``,          inline: true },
                    { name: '📊  Total',          value: `${keywords.length}`, inline: true },
                    { name: `${modeEmoji}  Mode`, value: keywordMode,          inline: true },
                    { name: '📋  Full list', value: kwList }
                )
                .setFooter({ text: `Requested by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL({ dynamic: true }) })
                .setTimestamp(now)
            ],
            ephemeral: true
        });
    } catch (err) { console.error(`❌ /addkeyword error: ${err.message}`); await replyError(interaction, now, `\`${err.message}\``); } }

    // ── /keywords ──────────────────────────────────────────
    else if (interaction.commandName === 'keywords') { try {
        const isRandom  = keywordMode === 'random';
        const modeEmoji = isRandom ? '🎲' : '🔁';
        const modeLabel = isRandom ? 'Random' : 'Sequential';
        const kwList    = keywords.map((k, i) => `> \`${String(i + 1).padStart(2, '0')}.\` ${k}`).join('\n') || '> *No keywords set*';

        await interaction.reply({
            embeds: [new EmbedBuilder()
                .setColor('#E60023')
                .setAuthor({ name: 'Pinterest Bot — Keywords', iconURL: interaction.client.user.displayAvatarURL() })
                .setTitle('📋  Active Keywords')
                .addFields(
                    { name: `${modeEmoji}  Mode`,  value: modeLabel,            inline: true },
                    { name: '📊  Total',            value: `${keywords.length}`, inline: true },
                    { name: '─────────────────', value: kwList }
                )
                .setFooter({ text: `Requested by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL({ dynamic: true }) })
                .setTimestamp(now)
            ],
            ephemeral: true
        });
    } catch (err) { console.error(`❌ /keywords error: ${err.message}`); await replyError(interaction, now, `\`${err.message}\``); } }

    // ── /removekeyword ─────────────────────────────────────
    else if (interaction.commandName === 'removekeyword') { try {
        const num = interaction.options.getInteger('number');
        const idx = num - 1;

        if (idx >= keywords.length) {
            return interaction.reply({
                embeds: [new EmbedBuilder()
                    .setColor('#ED4245')
                    .setAuthor({ name: 'Pinterest Bot — Error', iconURL: interaction.client.user.displayAvatarURL() })
                    .setTitle('❌  Invalid number')
                    .setDescription(`Number \`${num}\` is out of range — there are only **${keywords.length}** keyword${keywords.length !== 1 ? 's' : ''}.`)
                    .setFooter({ text: `Requested by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL({ dynamic: true }) })
                    .setTimestamp(now)
                ],
                ephemeral: true
            });
        }

        if (keywords.length === 1) {
            return interaction.reply({
                embeds: [new EmbedBuilder()
                    .setColor('#FEE75C')
                    .setAuthor({ name: 'Pinterest Bot — Warning', iconURL: interaction.client.user.displayAvatarURL() })
                    .setTitle('⚠️  Cannot remove last keyword')
                    .setDescription('At least one keyword must remain in the list.')
                    .setFooter({ text: `Requested by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL({ dynamic: true }) })
                    .setTimestamp(now)
                ],
                ephemeral: true
            });
        }

        const removed = keywords.splice(idx, 1)[0];
        if (_keywordIndex > 0) _keywordIndex = Math.min(_keywordIndex, keywords.length - 1);
        saveCache();

        const kwList = keywords.map((k, i) => `> \`${String(i + 1).padStart(2, '0')}.\` ${k}`).join('\n') || '> *No keywords set*';

        await interaction.reply({
            embeds: [new EmbedBuilder()
                .setColor('#ED4245')
                .setAuthor({ name: 'Pinterest Bot — Keyword Removed', iconURL: interaction.client.user.displayAvatarURL() })
                .setTitle('🗑️  Keyword removed')
                .addFields(
                    { name: '❌  Removed',   value: `\`${removed}\``,      inline: true },
                    { name: '📊  Remaining', value: `${keywords.length}`,  inline: true },
                    { name: '─────────────────', value: kwList }
                )
                .setFooter({ text: `Requested by ${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL({ dynamic: true }) })
                .setTimestamp(now)
            ],
            ephemeral: true
        });
    } catch (err) { console.error(`❌ /removekeyword error: ${err.message}`); await replyError(interaction, now, `\`${err.message}\``); } }
});

// ========== Bot Startup ==========
pinterestBot.once('ready', async () => {
    console.log(`✅ Pinterest bot ready: ${pinterestBot.user.tag}`);

    const updatePresence = () => pinterestBot.user.setPresence({
        status: 'idle',
        activities: [{ name: `in ${pinterestBot.guilds.cache.size} server(s)`, type: ActivityType.Watching }]
    });
    updatePresence();
    setInterval(updatePresence, 10 * 60 * 1000);

    loadCache();
    await registerSlashCommands();

    setTimeout(() => updatePinterestAvatar(), 5000);
    setInterval(updatePinterestAvatar, PINTEREST_CHANGE_INTERVAL * 1000);
});

pinterestBot.login(TOKEN_PINTEREST).catch(err => console.error('❌ Pinterest bot login failed:', err.message));
