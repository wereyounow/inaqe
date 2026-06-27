const { Client, GatewayIntentBits, EmbedBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ActivityType, SlashCommandBuilder, REST, Routes } = require('discord.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const sharp = require('sharp');

// ========== Settings ==========
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
];

// ========== Tokens ==========
const TOKEN_PINTEREST = process.env.TOKEN_PINTEREST ||'YwNTQ0NTc2Mw.Go-C1s.K4PdmeVO538wGP9wyoZU440_Xt_5R7ewuQNc';
const CLIENT_ID       = process.env.CLIENT_ID || '1515303677605445763';

if (!TOKEN_PINTEREST) {
    console.error('❌ TOKEN_PINTEREST must be set in environment variables');
    process.exit(1);
}

// ========== Channel IDs ==========
const PINTEREST_CHANNEL_ID = '1519470579508445194';

// ========== Developer IDs ==========
const DEVELOPER_IDS = ['1384688131374317598', '1471245404501839966'];

// ========== Image Settings ==========
const DEFAULT_KEYWORDS        = ['chainsawman icon', 'chainsawan aki Icon','Lara Croft icon','Cat icon'];
const PINTEREST_CHANGE_INTERVAL = 30;   // seconds between posts
const QUEUE_MIN               = 20;      // refill when queue drops below this
const QUEUE_TARGET            = 100;      // how many URLs to keep ready
const SEEN_MAX                = 10000000;    // max seen-URL history

const AVATARS_DIR = path.join(__dirname, 'avatars');
if (!fs.existsSync(AVATARS_DIR)) fs.mkdirSync(AVATARS_DIR, { recursive: true });

// ========== State ==========
const STATE_FILE        = path.join(__dirname, 'avatar_state.json');
const STATE_BACKUP_FILE = STATE_FILE + '.backup';

let keywords         = [...DEFAULT_KEYWORDS];
let keywordMode      = 'random';
let _keywordIndex    = 0;
let keywordBookmarks = {};       // keyword -> Pinterest bookmark token
let seenIds          = new Set(); // unique image IDs ever sent (dedup by content, not URL)

// In-memory queue of { url, keyword } items ready to post
let imageQueue    = [];
let isFetching    = false;

function loadState() {
    for (const file of [STATE_FILE, STATE_BACKUP_FILE]) {
        try {
            if (fs.existsSync(file)) {
                const data = JSON.parse(fs.readFileSync(file, 'utf8'));
                keywords         = data.keywords         ?? [...DEFAULT_KEYWORDS];
                keywordMode      = data.keywordMode      ?? 'random';
                _keywordIndex    = data.keywordIndex     ?? 0;
                keywordBookmarks = data.keywordBookmarks ?? {};
                seenIds          = new Set(data.seenIds ?? []);
                console.log(`📂 State loaded | Seen: ${seenIds.size} | Keywords: ${keywords.length} | Mode: ${keywordMode}`);
                return;
            }
        } catch (err) {
            console.warn(`⚠️ Could not read ${path.basename(file)}: ${err.message}`);
        }
    }
    keywords = [...DEFAULT_KEYWORDS];
    saveState();
    console.log('📂 New state file created');
}

function saveState() {
    try {
        const seenArr = [...seenIds].slice(-SEEN_MAX);
        const data = JSON.stringify({ keywords, keywordMode, keywordIndex: _keywordIndex, keywordBookmarks, seenIds: seenArr }, null, 2);
        if (fs.existsSync(STATE_FILE)) fs.copyFileSync(STATE_FILE, STATE_BACKUP_FILE);
        fs.writeFileSync(STATE_FILE, data, 'utf8');
    } catch (err) {
        console.error(`❌ Error saving state: ${err.message}`);
    }
}

// ========== Graceful Shutdown ==========
process.on('SIGTERM', () => { saveState(); process.exit(0); });
process.on('SIGINT',  () => { saveState(); process.exit(0); });

// ========== Bot Instance ==========
const pinterestBot = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

// ========== Utility ==========
function randomUA(exclude = null) {
    const pool = exclude ? USER_AGENTS.filter(u => u !== exclude) : USER_AGENTS;
    return pool[Math.floor(Math.random() * pool.length)];
}

async function withRetry(fn, maxRetries = 4) {
    let lastErr;
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn(i);
        } catch (err) {
            lastErr = err;
            if (i < maxRetries - 1) {
                const delay = Math.min(1000 * Math.pow(2, i), 10000);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    throw lastErr;
}

const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v', 'flv']);

function getImageFormat(url, buffer = null) {
    if (buffer && buffer.length >= 12) {
        // GIF
        if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'gif';
        // PNG
        if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'png';
        // JPEG
        if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'jpg';
        // WebP
        if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
            buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return 'webp';
        // MP4 / MOV (ftyp box)
        if (buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) return 'mp4';
        // WebM (EBML header)
        if (buffer[0] === 0x1A && buffer[1] === 0x45 && buffer[2] === 0xDF && buffer[3] === 0xA3) return 'webm';
    }
    if (url) {
        const ext = url.split('.').pop().toLowerCase().split('?')[0];
        if (VIDEO_EXTS.has(ext)) return ext;
        if (['gif', 'png', 'jpg', 'jpeg', 'webp'].includes(ext)) return ext === 'jpeg' ? 'jpg' : ext;
    }
    return 'jpg';
}

// ========== Video → GIF Conversion ==========
function videoToGif(videoBuffer, videoExt) {
    return new Promise((resolve, reject) => {
        const tmpDir   = os.tmpdir();
        const inFile   = path.join(tmpDir, `pin_in_${Date.now()}.${videoExt}`);
        const outFile  = path.join(tmpDir, `pin_out_${Date.now()}.gif`);
        const palFile  = path.join(tmpDir, `pin_pal_${Date.now()}.png`);

        try { fs.writeFileSync(inFile, videoBuffer); } catch (e) { return reject(e); }

        const cleanup = () => {
            for (const f of [inFile, outFile, palFile]) {
                try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
            }
        };

        // Step 1: generate palette for better GIF quality
        execFile('ffmpeg', [
            '-y', '-i', inFile,
            '-vf', 'fps=12,scale=480:-1:flags=lanczos,palettegen=max_colors=128',
            palFile
        ], { timeout: 30000 }, (err) => {
            if (err) {
                cleanup();
                return reject(new Error(`palette gen failed: ${err.message}`));
            }

            // Step 2: convert video to GIF using palette
            execFile('ffmpeg', [
                '-y', '-i', inFile, '-i', palFile,
                '-lavfi', 'fps=12,scale=480:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer',
                '-t', '15',
                outFile
            ], { timeout: 60000 }, (err2) => {
                if (err2) {
                    cleanup();
                    return reject(new Error(`video→gif failed: ${err2.message}`));
                }

                try {
                    const gif = fs.readFileSync(outFile);
                    cleanup();
                    resolve(gif);
                } catch (e) {
                    cleanup();
                    reject(e);
                }
            });
        });
    });
}

// Extract the unique image identifier from a Pinterest URL.
// Pinterest serves the same image under different size paths:
//   https://i.pinimg.com/736x/ab/cd/ef/IMAGEID.jpg
//   https://i.pinimg.com/originals/ab/cd/ef/IMAGEID.jpg
// The filename (IMAGEID) is always the same regardless of size — use it as the dedup key.
function getPinImageId(url) {
    try {
        const match = url.match(/\/([^/?#]+)\.\w{2,5}(?:[?#].*)?$/);
        return match ? match[1].toLowerCase() : url;
    } catch {
        return url;
    }
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
async function fetchPinterestPage(keyword, bookmark) {
    const ua = randomUA();
    const source_url = `/search/pins/?q=${encodeURIComponent(keyword)}&rs=typed`;
    const payload = JSON.stringify({
        options: {
            query: keyword,
            scope: 'pins',
            page_size: 50,
            bookmarks: bookmark ? [bookmark] : [],
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
    const url = `https://www.pinterest.com/resource/BaseSearchResource/get/?source_url=${encodeURIComponent(source_url)}&data=${encodeURIComponent(payload)}`;

    const res = await axios.get(url, {
        timeout: 20000,
        headers: {
            'User-Agent': ua,
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'Accept-Language': 'en-US,en;q=0.9',
            'X-Requested-With': 'XMLHttpRequest',
            'x-pinterest-pws-handler': 'www/search/[scope].js',
            'Referer': `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(keyword)}`,
        },
    });

    const results     = res.data?.resource_response?.data?.results ?? [];
    const nextBookmark = res.data?.resource_response?.bookmark ?? null;

    // Prefer highest-quality image available
    const urls = results
        .map(r => {
            const img = r?.images;
            return img?.orig?.url || img?.['736x']?.url || img?.['474x']?.url;
        })
        .filter(u => u?.startsWith('http'));

    return { urls, nextBookmark };
}

// ========== Queue Filler ==========
// Fetches pages for all keywords in parallel and adds fresh URLs to imageQueue.
async function fillQueue() {
    if (isFetching) return;
    isFetching = true;
    console.log(`🔃 Filling queue (current: ${imageQueue.length}) ...`);

    try {
        const needed = QUEUE_TARGET - imageQueue.length;
        if (needed <= 0) { isFetching = false; return; }

        // Fetch from every keyword in parallel, each responsible for its share
        const kwList = keywords.length > 0 ? keywords : DEFAULT_KEYWORDS;
        const perKw  = Math.ceil(needed / kwList.length);
        const results = await Promise.allSettled(
            kwList.map(kw => fetchOneKeyword(kw, perKw))
        );

        let added = 0;
        for (const r of results) {
            if (r.status === 'fulfilled') added += r.value;
        }

        console.log(`✅ Queue filled: +${added} new | total ready: ${imageQueue.length}`);
        saveState();
    } catch (err) {
        console.error(`❌ fillQueue error: ${err.message}`);
    } finally {
        isFetching = false;
    }
}

// Fetch multiple pages for a keyword until `needed` fresh images are added.
// Each call advances the bookmark so subsequent calls always get a new page.
async function fetchOneKeyword(keyword, needed = QUEUE_TARGET) {
    let totalAdded = 0;
    const MAX_PAGES = 10; // safety cap per fill cycle

    for (let page = 0; page < MAX_PAGES; page++) {
        if (totalAdded >= needed) break;

        const bookmark = keywordBookmarks[keyword] ?? null;

        try {
            const { urls, nextBookmark } = await withRetry(
                (attempt) => fetchPinterestPage(keyword, attempt === 0 ? bookmark : null),
                4
            );

            if (!urls || urls.length === 0) {
                delete keywordBookmarks[keyword];
                console.log(`  🔁 "${keyword}" — empty page, resetting bookmark`);
                break;
            }

            // Advance bookmark — if null we reached the last page, cycle back to page 1
            if (nextBookmark) {
                keywordBookmarks[keyword] = nextBookmark;
            } else {
                delete keywordBookmarks[keyword];
                console.log(`  🔁 "${keyword}" — last page reached, will cycle from page 1 next fill`);
            }

            // Add only images not seen before.
            // Double check: image ID (catches same image via different size URL)
            //             + full URL  (catches exact duplicate links)
            let pageAdded = 0;
            for (const url of urls) {
                const id = getPinImageId(url);
                if (!seenIds.has(id) && !seenIds.has(url)) {
                    seenIds.add(id);   // block by image ID
                    seenIds.add(url);  // block by exact URL too
                    imageQueue.push({ url, keyword, id });
                    pageAdded++;
                    totalAdded++;
                }
            }

            console.log(`  📌 "${keyword}" p${page + 1} → ${urls.length} found, ${pageAdded} fresh | bookmark: ${nextBookmark ? 'next' : 'end'}`);

            // If page had no fresh images and we're at end, stop early
            if (pageAdded === 0 && !nextBookmark) break;

        } catch (err) {
            console.error(`  ⚠️ "${keyword}" p${page + 1} failed: ${err.message}`);
            delete keywordBookmarks[keyword];
            break;
        }
    }

    return totalAdded;
}

// Pick next item from the queue respecting keywordMode:
//   random     → pick any item at random
//   sequential → rotate through keywords in order; only advance the index
//                when a matching item is actually found in the queue
function dequeueNext() {
    if (imageQueue.length === 0) return null;

    let idx;
    if (keywordMode === 'sequential' && keywords.length > 0) {
        // Try each keyword in rotation until one has an item in the queue
        for (let attempt = 0; attempt < keywords.length; attempt++) {
            const targetKw = keywords[_keywordIndex % keywords.length];
            const matchIdx = imageQueue.findIndex(item => item.keyword === targetKw);
            if (matchIdx !== -1) {
                _keywordIndex++; // advance only when we actually found a match
                idx = matchIdx;
                break;
            }
            // No items for this keyword yet — skip to next without losing the index
            _keywordIndex++;
        }
        // If no keyword had a match, fall back to random
        if (idx === undefined) {
            idx = Math.floor(Math.random() * imageQueue.length);
        }
    } else {
        idx = Math.floor(Math.random() * imageQueue.length);
    }

    const [item] = imageQueue.splice(idx, 1);
    // Trim seenIds if it grew too large (safety valve).
    if (seenIds.size > SEEN_MAX) {
        const arr = [...seenIds];
        seenIds = new Set(arr.slice(arr.length - SEEN_MAX));
    }
    return item;
}

// ========== Image Download ==========
async function downloadImage(url) {
    return withRetry(async (attempt) => {
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': randomUA(),
                'Accept': 'image/png,image/gif,image/jpeg,image/webp,*/*',
                'Referer': 'https://www.pinterest.com/',
            },
            timeout: 30000,
        });
        const buffer = Buffer.from(response.data);
        const format = getImageFormat(url, buffer);
        return { buffer, format, size: buffer.length };
    }, 4);
}

// ========== Image Update ==========
async function updatePinterestAvatar() {
    console.log(`\n🔄 [${new Date().toLocaleString()}] Updating...`);

    // Trigger background refill if queue is low
    if (imageQueue.length <= QUEUE_MIN) {
        fillQueue().catch(err => console.error(`❌ Background fill failed: ${err.message}`));
    }

    // If queue empty, wait for first fill to complete
    if (imageQueue.length === 0) {
        console.warn('⏳ Queue empty — waiting for fill...');
        await fillQueue();
        if (imageQueue.length === 0) {
            console.error('❌ Queue still empty after fill — skipping this cycle');
            return;
        }
    }

    const item = dequeueNext();
    if (!item) return;

    const imageId = item.id ?? getPinImageId(item.url);
    console.log(`🖼️  [${item.keyword}] id: ${imageId} | queue: ${imageQueue.length} remaining`);
    console.log(`🔗 ${item.url}`);

    try {
        const result = await downloadImage(item.url);

        if (result.size < 1000) {
            console.warn('⚠️ Image too small, skipping');
            return;
        }

        // ── Video → GIF ──────────────────────────────────────
        if (VIDEO_EXTS.has(result.format)) {
            console.log(`🎬 Video detected (${result.format.toUpperCase()}, ${(result.size / 1024).toFixed(1)}KB) — converting to GIF...`);
            try {
                const gifBuffer = await videoToGif(result.buffer, result.format);
                result.buffer = gifBuffer;
                result.size   = gifBuffer.length;
                result.format = 'gif';
                console.log(`✅ Converted to GIF: ${(result.size / 1024).toFixed(1)}KB`);
            } catch (convErr) {
                console.warn(`⚠️ Video→GIF failed: ${convErr.message}, skipping`);
                return;
            }
        }

        const MAX_DISCORD_SIZE = 8 * 1024 * 1024; // 8MB Discord limit
        if (result.size > MAX_DISCORD_SIZE) {
            console.warn(`⚠️ Image too large (${(result.size / 1024 / 1024).toFixed(2)}MB), resizing...`);
            try {
                const isGif = result.format === 'gif';
                let resized = null;

                if (isGif) {
                    // GIF: try reducing size step by step while keeping animation
                    const gifSteps = [
                        { width: 800 },
                        { width: 640 },
                        { width: 512 },
                        { width: 400 },
                        { width: 320 },
                        { width: 256 },
                        { width: 192 },
                        { width: 128 },
                    ];
                    for (const step of gifSteps) {
                        resized = await sharp(result.buffer, { animated: true })
                            .resize({ width: step.width, withoutEnlargement: true })
                            .gif()
                            .toBuffer();
                        console.log(`  🔁 GIF → ${step.width}px = ${(resized.length / 1024).toFixed(1)}KB`);
                        if (resized.length <= MAX_DISCORD_SIZE) break;
                    }

                    // GIF احتياطي: تحويل لـ JPEG ثابت بخطوات تدريجية
                    if (resized && resized.length > MAX_DISCORD_SIZE) {
                        console.warn('⚠️ GIF لا يزال كبيراً — تحويل لـ JPEG ثابت...');
                        const jpegSteps = [
                            { width: 1920, quality: 90 },
                            { width: 1280, quality: 85 },
                            { width: 1024, quality: 80 },
                            { width: 800,  quality: 75 },
                        ];
                        for (const step of jpegSteps) {
                            resized = await sharp(result.buffer, { animated: false })
                                .resize({ width: step.width, withoutEnlargement: true })
                                .jpeg({ quality: step.quality })
                                .toBuffer();
                            console.log(`  🔁 GIF→JPEG ${step.width}px q${step.quality} = ${(resized.length / 1024).toFixed(1)}KB`);
                            if (resized.length <= MAX_DISCORD_SIZE) break;
                        }
                        result.format = 'jpg';
                    }
                } else {
                    // Static image: try quality reduction first, then width reduction
                    const steps = [
                        { width: 4096, quality: 90 },
                        { width: 3000, quality: 85 },
                        { width: 2560, quality: 85 },
                        { width: 1920, quality: 85 },
                        { width: 1600, quality: 85 },
                        { width: 1280, quality: 85 },
                        { width: 1280, quality: 80 },
                        { width: 1024, quality: 80 },
                        { width: 1024, quality: 75 },
                        { width: 800,  quality: 75 },
                        { width: 800,  quality: 70 },
                    ];
                    for (const step of steps) {
                        resized = await sharp(result.buffer)
                            .resize({ width: step.width, withoutEnlargement: true })
                            .jpeg({ quality: step.quality })
                            .toBuffer();
                        console.log(`  🔁 ${step.width}px q${step.quality} = ${(resized.length / 1024).toFixed(1)}KB`);
                        if (resized.length <= MAX_DISCORD_SIZE) break;
                    }
                    result.format = 'jpg';
                }

                // ── Safety fallback: force under 8MB no matter what ──
                if (resized && resized.length > MAX_DISCORD_SIZE) {
                    console.warn('⚠️ Still over 8MB — applying emergency fallback...');
                    let quality = 65;
                    let width   = 640;
                    while (resized.length > MAX_DISCORD_SIZE && quality >= 10) {
                        resized = await sharp(resized)
                            .resize({ width, withoutEnlargement: true })
                            .jpeg({ quality })
                            .toBuffer();
                        console.log(`  🆘 fallback ${width}px q${quality} = ${(resized.length / 1024).toFixed(1)}KB`);
                        quality -= 10;
                        width    = Math.max(Math.floor(width * 0.8), 128);
                    }
                    result.format = 'jpg';
                }

                result.buffer = resized;
                result.size   = resized.length;
                console.log(`✅ Final size: ${(result.size / 1024).toFixed(1)}KB`);
            } catch (resizeErr) {
                console.warn(`⚠️ Resize failed: ${resizeErr.message}, skipping`);
                return;
            }
        }

        console.log(`📦 ${(result.size / 1024).toFixed(1)}KB | ${result.format.toUpperCase()}`);

        let channel = pinterestBot.channels.cache.get(PINTEREST_CHANNEL_ID);
        if (!channel) {
            try { channel = await pinterestBot.channels.fetch(PINTEREST_CHANNEL_ID); }
            catch (err) { console.error(`❌ Could not access channel: ${err.message}`); return; }
        }

        if (!channel) {
            console.error('❌ Channel not found');
            return;
        }

        const imgName = `anime.${result.format}`;

        const sent = await channel.send({
            embeds: [new EmbedBuilder()
                .setTitle('Avatar — Pinterest')
                .setDescription(`🔍 \`${item.keyword}\``)
                .setImage(`attachment://${imgName}`)
                .setColor('#E60023')
            ],
            files: [new AttachmentBuilder(result.buffer, { name: imgName })],
        });

        const att = sent.attachments.find(a => a.name === imgName);
        if (att) {
            await sent.edit({
                embeds: [new EmbedBuilder()
                    .setTitle('Avatar — Pinterest')
                    .setDescription(`🔍 \`${item.keyword}\``)
                    .setURL(att.url)
                    .setImage(`attachment://${imgName}`)
                    .setColor('#E60023')
                ],
                components: [new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setLabel('🖼️ Image').setURL(att.url).setStyle(ButtonStyle.Link)
                )],
            });
        }

        console.log(`✅ Sent | queue: ${imageQueue.length} | seen: ${seenIds.size}`);
        saveState();

    } catch (err) {
        console.error(`❌ Post failed: ${err.message}`);
        // Put the URL back if we failed to send it
        imageQueue.unshift(item);
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
                    .setDescription('Show all current keywords, queue size, and the active mode'),

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
            .setFooter({ text: `Requested by ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() })
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
    if (!interaction.isChatInputCommand()) return;

    if (!DEVELOPER_IDS.includes(interaction.user.id)) {
        return interaction.reply({
            embeds: [new EmbedBuilder()
                .setColor('#ED4245')
                .setAuthor({ name: 'Pinterest Bot — Access Denied', iconURL: interaction.client.user.displayAvatarURL() })
                .setTitle('🔒  Unauthorized')
                .setDescription('This command is restricted to **bot developers** only.')
                .setFooter({ text: `Requested by ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() })
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
        saveState();

        const isRandom  = keywordMode === 'random';
        const modeColor = isRandom ? '#5865F2' : '#57F287';
        const modeEmoji = isRandom ? '🎲' : '🔁';
        const modeLabel = isRandom ? 'Random' : 'Sequential';
        const modeDesc  = isRandom
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
                .setFooter({ text: `Requested by ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() })
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
                    .setFooter({ text: `Requested by ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() })
                    .setTimestamp(now)
                ],
                ephemeral: true
            });
        }

        keywords.push(kw);
        saveState();

        // Immediately fetch this new keyword in background
        fetchOneKeyword(kw).then(n => {
            if (n > 0) { saveState(); console.log(`  ✅ Pre-fetched ${n} from new keyword "${kw}"`); }
        }).catch(() => {});

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
                .setFooter({ text: `Requested by ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() })
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
                    { name: `${modeEmoji}  Mode`,  value: modeLabel,              inline: true },
                    { name: '📊  Total',            value: `${keywords.length}`,   inline: true },
                    { name: '🗂️  Queue',            value: `${imageQueue.length}`, inline: true },
                    { name: '─────────────────', value: kwList }
                )
                .setFooter({ text: `Requested by ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() })
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
                    .setFooter({ text: `Requested by ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() })
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
                    .setFooter({ text: `Requested by ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() })
                    .setTimestamp(now)
                ],
                ephemeral: true
            });
        }

        const removed = keywords.splice(idx, 1)[0];
        if (_keywordIndex > 0) _keywordIndex = Math.min(_keywordIndex, keywords.length - 1);
        delete keywordBookmarks[removed];
        // Remove any queued items from this keyword
        imageQueue = imageQueue.filter(item => item.keyword !== removed);
        saveState();

        const kwList = keywords.map((k, i) => `> \`${String(i + 1).padStart(2, '0')}.\` ${k}`).join('\n') || '> *No keywords set*';

        await interaction.reply({
            embeds: [new EmbedBuilder()
                .setColor('#ED4245')
                .setAuthor({ name: 'Pinterest Bot — Keyword Removed', iconURL: interaction.client.user.displayAvatarURL() })
                .setTitle('🗑️  Keyword removed')
                .addFields(
                    { name: '❌  Removed',   value: `\`${removed}\``,      inline: true },
                    { name: '📊  Remaining', value: `${keywords.length}`,   inline: true },
                    { name: '─────────────────', value: kwList }
                )
                .setFooter({ text: `Requested by ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() })
                .setTimestamp(now)
            ],
            ephemeral: true
        });
    } catch (err) { console.error(`❌ /removekeyword error: ${err.message}`); await replyError(interaction, now, `\`${err.message}\``); } }
});

// ========== Bot Startup ==========
pinterestBot.once('ready', async () => {
    console.log(`✅ Pinterest bot ready: ${pinterestBot.user.username}`);

    const updatePresence = () => pinterestBot.user.setPresence({
        status: 'idle',
        activities: [{ name: `in ${pinterestBot.guilds.cache.size} server(s)`, type: ActivityType.Watching }]
    });
    updatePresence();
    setInterval(updatePresence, 10 * 60 * 1000);

    loadState();
    await registerSlashCommands();

    // Fill the queue before the first post
    await fillQueue();

    // First post after 5 seconds
    setTimeout(() => updatePinterestAvatar(), 5000);
    setInterval(updatePinterestAvatar, PINTEREST_CHANGE_INTERVAL * 1000);

    // Periodic refill every 10 minutes regardless of queue level
    setInterval(() => {
        if (!isFetching) fillQueue().catch(() => {});
    }, 10 * 60 * 1000);
});

pinterestBot.login(TOKEN_PINTEREST).catch(err => console.error('❌ Pinterest bot login failed:', err.message));
