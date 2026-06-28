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
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.4; rv:124.0) Gecko/20100101 Firefox/124.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0',
];

// ========== Tokens ==========
const TOKEN_PINTEREST = process.env.TOKEN_PINTEREST ||'MTQ4MTcxzE4MzY5Mzg2NA.GAVqqG.MotfSK_4UrPFpxlABC39p34JAlSxN8WU1732tk';
const CLIENT_ID       = process.env.CLIENT_ID || '1481717883183693864';

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
let autoExpand       = true;     // whether to auto-expand keywords via guided search when filling queue
let keywordBookmarks = {};       // keyword -> Pinterest bookmark token
let seenIds          = new Set(); // unique image IDs ever sent (dedup by content, not URL)

// In-memory queue of { url, keyword } items ready to post
let imageQueue    = [];
let isFetching    = false;

// URLs that failed all download retries — skip them permanently this session
const failedUrls  = new Set();

function loadState() {
    for (const file of [STATE_FILE, STATE_BACKUP_FILE]) {
        try {
            if (fs.existsSync(file)) {
                const data = JSON.parse(fs.readFileSync(file, 'utf8'));
                keywords         = data.keywords         ?? [...DEFAULT_KEYWORDS];
                keywordMode      = data.keywordMode      ?? 'random';
                _keywordIndex    = data.keywordIndex     ?? 0;
                autoExpand       = data.autoExpand       ?? true;
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
        const data = JSON.stringify({ keywords, keywordMode, keywordIndex: _keywordIndex, autoExpand, keywordBookmarks, seenIds: seenArr }, null, 2);
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
                const is429  = err?.response?.status === 429;
                const base   = is429 ? 30000 : Math.min(1000 * Math.pow(2, i), 10000);
                const jitter = Math.floor(Math.random() * 500);
                if (is429) console.warn(`⚠️ Rate limited by Pinterest — waiting ${((base + jitter) / 1000).toFixed(1)}s...`);
                await new Promise(r => setTimeout(r, base + jitter));
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

// Upgrade a Pinterest CDN URL from a sized path to full-resolution originals.
// e.g. https://i.pinimg.com/736x/ab/cd/ef/img.jpg
//   → https://i.pinimg.com/originals/ab/cd/ef/img.jpg
function upgradeToOriginals(url) {
    try {
        return url.replace(/\/\d+x\//, '/originals/');
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

// Pick the highest-quality static image URL from a pin's images object.
function bestImageUrl(images) {
    if (!images) return null;
    return (
        images?.orig?.url      ||
        images?.['1200x']?.url ||
        images?.['736x']?.url  ||
        images?.['600x']?.url  ||
        images?.['474x']?.url  ||
        images?.['236x']?.url  ||
        null
    );
}

// Pick the highest-quality video URL from a pin's video_list object.
// Pinterest orders video_list keys like V_720P, V_480P, V_360P, V_HLS …
function bestVideoUrl(videoList) {
    if (!videoList || typeof videoList !== 'object') return null;
    // HLS (.m3u8) playlists can't be downloaded with a simple GET — skip them
    const isDownloadable = url => url?.startsWith('http') && !url.includes('.m3u8');
    const PREF = ['V_720P', 'V_480P', 'V_360P'];
    for (const key of PREF) {
        const url = videoList[key]?.url;
        if (isDownloadable(url)) return url;
    }
    // Fallback: take the first directly downloadable URL
    for (const val of Object.values(videoList)) {
        if (isDownloadable(val?.url)) return val.url;
    }
    return null;
}

// Build realistic browser headers for a given UA to reduce Pinterest blocking.
function pinterestHeaders(ua, keyword) {
    return {
        'User-Agent':              ua,
        'Accept':                  'application/json, text/javascript, */*; q=0.01',
        'Accept-Language':         'en-US,en;q=0.9',
        'Accept-Encoding':         'gzip, deflate, br',
        'X-Requested-With':        'XMLHttpRequest',
        'x-pinterest-pws-handler': 'www/search/[scope].js',
        'x-app-version':           '1.0',
        'DNT':                     '1',
        'Cache-Control':           'no-cache',
        'Pragma':                  'no-cache',
        'sec-fetch-dest':          'empty',
        'sec-fetch-mode':          'cors',
        'sec-fetch-site':          'same-origin',
        'Referer': `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(keyword)}`,
    };
}

async function fetchPinterestPage(keyword, bookmark) {
    const ua = randomUA();
    const source_url = `/search/pins/?q=${encodeURIComponent(keyword)}&rs=typed`;
    const payload = JSON.stringify({
        options: {
            query: keyword,
            scope: 'pins',
            page_size: 250,           // up from 50 — fewer round-trips
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
        headers: pinterestHeaders(ua, keyword),
    });

    // Validate API-level status (Pinterest returns 200 HTTP even on soft errors)
    const apiStatus = res.data?.resource_response?.status;
    if (apiStatus && apiStatus !== 'success') {
        throw new Error(`Pinterest API status: ${apiStatus}`);
    }

    const results      = res.data?.resource_response?.data?.results ?? [];
    const nextBookmark = res.data?.resource_response?.bookmark ?? null;

    const items = [];
    for (const r of results) {
        // Skip promoted / ad pins — they're often low-quality or off-topic
        if (r?.promoted_pin_presenters?.length || r?.ad_destination_url) continue;

        const pinId = r?.id ? String(r.id) : null;

        // 1. Try video URL first (richer content)
        const videoList = r?.videos?.video_list;
        const videoUrl  = bestVideoUrl(videoList);
        if (videoUrl) {
            items.push({ url: videoUrl, pinId });
            continue;
        }

        // 2. Fall back to best static image, upgraded to originals resolution
        const imgUrl = bestImageUrl(r?.images);
        if (imgUrl) items.push({ url: upgradeToOriginals(imgUrl), pinId });
    }

    return { items, nextBookmark };
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

        // If auto-expand is on, discover guided search variants and add new ones before fetching
        if (autoExpand) {
            const base = keywords.length > 0 ? [...keywords] : DEFAULT_KEYWORDS;
            for (const kw of base) {
                const variants = await expandKeyword(kw).catch(() => []);
                const toAdd = variants.filter(v => v !== kw && !keywords.includes(v));
                for (const v of toAdd) keywords.push(v);
                if (toAdd.length > 0) console.log(`🔍 Auto-expanded "${kw}" → +${toAdd.length} variants`);
            }
            if (keywords.some((_,i) => i >= base.length)) saveState();
        }

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

        // Shuffle queue so items from different keywords interleave instead of batching
        for (let i = imageQueue.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [imageQueue[i], imageQueue[j]] = [imageQueue[j], imageQueue[i]];
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
            const { items, nextBookmark } = await withRetry(
                (attempt) => fetchPinterestPage(keyword, attempt === 0 ? bookmark : null),
                4
            );

            if (!items || items.length === 0) {
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

            // Dedup by pin ID (from API) first, then by parsed image filename as fallback.
            // This catches the same pin served under different size URLs.
            let pageAdded = 0;
            for (const { url, pinId } of items) {
                const fileId = getPinImageId(url);
                const dedupKey = pinId ?? fileId;
                if (!seenIds.has(dedupKey) && !seenIds.has(fileId)) {
                    seenIds.add(dedupKey);
                    seenIds.add(fileId);
                    imageQueue.push({ url, keyword, id: dedupKey });
                    pageAdded++;
                    totalAdded++;
                }
            }

            console.log(`  📌 "${keyword}" p${page + 1} → ${items.length} found, ${pageAdded} fresh | bookmark: ${nextBookmark ? 'next' : 'end'}`);

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
    // For Pinterest CDN images, try upgrading to originals first for best quality.
    // If originals returns a non-200 (e.g. 403/404), fall back to the original URL.
    const originalsUrl = upgradeToOriginals(url);
    const urlsToTry    = originalsUrl !== url ? [originalsUrl, url] : [url];

    let lastErr;
    for (const tryUrl of urlsToTry) {
        try {
            return await withRetry(async () => {
                const response = await axios({
                    url: tryUrl,
                    method: 'GET',
                    responseType: 'arraybuffer',
                    headers: {
                        'User-Agent': randomUA(),
                        'Accept': 'image/png,image/gif,image/jpeg,image/webp,*/*',
                        'Accept-Encoding': 'gzip, deflate, br',
                        'Referer': 'https://www.pinterest.com/',
                    },
                    timeout: 30000,
                });
                const buffer = Buffer.from(response.data);
                const format = getImageFormat(tryUrl, buffer);
                return { buffer, format, size: buffer.length };
            }, 3);
        } catch (err) {
            lastErr = err;
            if (urlsToTry.length > 1) console.warn(`⚠️ Download failed for ${tryUrl.includes('originals') ? 'originals' : 'sized'} URL — trying fallback...`);
        }
    }
    throw lastErr;
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

    // Skip permanently blacklisted URLs
    if (failedUrls.has(item.url)) {
        console.warn(`⛔ Skipping blacklisted URL: ${item.url}`);
        return;
    }

    const imageId = item.id ?? getPinImageId(item.url);
    console.log(`🖼️  [${item.keyword}] id: ${imageId} | queue: ${imageQueue.length} remaining`);
    console.log(`🔗 ${item.url}`);

    let downloadOk = false;
    try {
        const result = await downloadImage(item.url);
        downloadOk = true;

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

                    // Fallback: convert oversized GIF to static JPEG
                    if (resized && resized.length > MAX_DISCORD_SIZE) {
                        console.warn('⚠️ GIF still too large — converting to static JPEG...');
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
        if (!downloadOk) {
            // Download itself failed — blacklist so we never retry this URL
            failedUrls.add(item.url);
            console.warn(`⛔ URL blacklisted after repeated download failures: ${item.url}`);
        } else {
            // Download succeeded but Discord send failed — put it back to retry next cycle
            imageQueue.unshift(item);
        }
    }
}

// ========== Keyword Variants (from Pinterest guided search) ==========
const guidedCache = {};

async function fetchPinterestGuides(keyword) {
    if (guidedCache[keyword]) return guidedCache[keyword];

    try {
        const ua = randomUA();
        const source_url = `/search/pins/?q=${encodeURIComponent(keyword)}&rs=typed`;
        const payload = JSON.stringify({
            options: { query: keyword, scope: 'pins' },
            context: {}
        });
        const url = `https://www.pinterest.com/resource/GuideSearchResource/get/?source_url=${encodeURIComponent(source_url)}&data=${encodeURIComponent(payload)}`;

        const res = await axios.get(url, {
            timeout: 15000,
            headers: pinterestHeaders(ua, keyword),
        });

        const guides = res.data?.resource_response?.data?.guides ?? [];
        const terms  = guides
            .map(g => g?.display_name || g?.term)
            .filter(Boolean)
            .slice(0, 8);

        if (terms.length > 0) {
            const variants = [keyword, ...terms.map(t => `${keyword} ${t}`)];
            guidedCache[keyword] = variants;
            console.log(`🔍 Guides for "${keyword}": ${terms.join(', ')}`);
            return variants;
        }
    } catch (err) {
        console.warn(`⚠️ Could not fetch guides for "${keyword}": ${err.message}`);
    }

    const FALLBACK = ['pfp', 'game', 'dark', 'aesthetic', 'anime'];
    const base = keyword.toLowerCase();
    const variants = [keyword, ...FALLBACK.filter(s => !base.includes(s)).map(s => `${keyword} ${s}`)];
    guidedCache[keyword] = variants;
    return variants;
}

async function expandKeyword(kw) {
    return fetchPinterestGuides(kw);
}

// ========== Slash Commands ==========
async function registerSlashCommands() {
    const rest = new REST({ version: '10' }).setToken(TOKEN_PINTEREST);
    try {
        await rest.put(Routes.applicationCommands(CLIENT_ID), {
            body: [
                new SlashCommandBuilder()
                    .setName('help')
                    .setDescription('Show all available bot commands and what they do'),

                new SlashCommandBuilder()
                    .setName('clearcache')
                    .setDescription('Clear all internal caches (guided search, failed URLs, bookmarks)'),

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
                    .setDescription('Remove a keyword from the Pinterest list')
                    .addStringOption(opt => opt
                        .setName('keyword')
                        .setDescription('Choose a keyword from the list')
                        .setRequired(true)
                        .setAutocomplete(true)
                    ),

                new SlashCommandBuilder()
                    .setName('expandkeyword')
                    .setDescription('Toggle auto-expand: bot discovers Pinterest guided search variants and adds them automatically'),

                new SlashCommandBuilder()
                    .setName('editkeyword')
                    .setDescription('Replace an existing keyword with a new one')
                    .addStringOption(opt => opt
                        .setName('keyword')
                        .setDescription('Choose the keyword to edit')
                        .setRequired(true)
                        .setAutocomplete(true)
                    )
                    .addStringOption(opt => opt
                        .setName('newkeyword')
                        .setDescription('The replacement keyword (e.g. "chainsawman pfp")')
                        .setRequired(true)
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
            .setThumbnail(interaction.client.user.displayAvatarURL())
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

// ========== Autocomplete Handler ==========
pinterestBot.on('interactionCreate', async (interaction) => {
    if (!interaction.isAutocomplete()) return;
    if (!DEVELOPER_IDS.includes(interaction.user.id)) return await interaction.respond([]).catch(() => {});

    const focused = interaction.options.getFocused().toLowerCase();
    const choices = keywords
        .filter(kw => kw.toLowerCase().includes(focused))
        .slice(0, 25)
        .map(kw => ({ name: kw, value: kw }));

    await interaction.respond(choices).catch(() => {});
});

// ========== Interaction Handler ==========
pinterestBot.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (!DEVELOPER_IDS.includes(interaction.user.id)) {
        return interaction.reply({
            embeds: [new EmbedBuilder()
                .setColor('#ED4245')
                .setAuthor({ name: 'Pinterest Bot — Access Denied', iconURL: interaction.client.user.displayAvatarURL() })
                .setThumbnail(interaction.client.user.displayAvatarURL())
                .setTitle('🔒  Unauthorized')
                .setDescription('This command is restricted to **bot developers** only.')
                .setFooter({ text: `Requested by ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() })
                .setTimestamp()
            ],
            ephemeral: true
        });
    }

    const now = new Date();

    // ── /clearcache ────────────────────────────────────────
    if (interaction.commandName === 'clearcache') { try {
        const guidedCount  = Object.keys(guidedCache).length;
        const failedCount  = failedUrls.size;
        const bookmarkCount = Object.keys(keywordBookmarks).length;

        for (const k of Object.keys(guidedCache))    delete guidedCache[k];
        failedUrls.clear();
        for (const k of Object.keys(keywordBookmarks)) delete keywordBookmarks[k];
        saveState();

        await interaction.reply({
            embeds: [new EmbedBuilder()
                .setColor('#57F287')
                .setAuthor({ name: 'Pinterest Bot — Cache Cleared', iconURL: interaction.client.user.displayAvatarURL() })
                .setThumbnail(interaction.client.user.displayAvatarURL())
                .setTitle('🧹  Cache cleared successfully')
                .addFields(
                    { name: '🔍  Guided cache',   value: `${guidedCount} entries removed`,   inline: true },
                    { name: '🚫  Failed URLs',     value: `${failedCount} URLs unblocked`,    inline: true },
                    { name: '🔖  Bookmarks',       value: `${bookmarkCount} pages reset`,     inline: true },
                )
                .setDescription('-# The bot can now re-fetch fresh data from Pinterest from scratch')
                .setFooter({ text: `Requested by ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() })
                .setTimestamp(now)
            ],
            ephemeral: true
        });
    } catch (err) { console.error(`❌ /clearcache error: ${err.message}`); await replyError(interaction, now, `\`${err.message}\``); } }

    // ── /help ──────────────────────────────────────────────
    else if (interaction.commandName === 'help') { try {
        const botAvatar = interaction.client.user.displayAvatarURL();
        await interaction.reply({
            embeds: [new EmbedBuilder()
                .setColor('#E60023')
                .setAuthor({ name: 'Pinterest Bot — Help', iconURL: botAvatar })
                .setThumbnail(botAvatar)
                .setTitle('📖  الأوامر المتاحة')
                .addFields(
                    { name: '# /help',          value: '-# يعرض قائمة بكل الأوامر المتاحة وشرح لكل واحد' },
                    { name: '# /clearcache',    value: '-# يمسح كل الـ cache الداخلي (guided search، روابط فاشلة، bookmarks)' },
                    { name: '# /keywords',      value: '-# يعرض كل الكلمات المفعّلة، حجم الـ queue، والوضع الحالي' },
                    { name: '## /addkeyword',    value: '-# يضيف كلمة بحث جديدة لقائمة Pinterest' },
                    { name: '## /removekeyword', value: '-# يحذف كلمة بحث من القائمة (اختر من القائمة المنسدلة)' },
                    { name: '## /editkeyword',   value: '-# يستبدل كلمة موجودة بكلمة جديدة (اختر القديمة وأدخل الجديدة)' },
                    { name: '## /expandkeyword', value: '-# يشغّل أو يوقف التوسيع التلقائي للكلمات عبر Pinterest Guided Search' },
                    { name: '## /mode',          value: '-# يبدّل بين وضعين: 🎲 عشوائي أو 🔁 ترتيبي' },
                )
                .setFooter({ text: `Requested by ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() })
                .setTimestamp(now)
            ],
            ephemeral: true
        });
    } catch (err) { console.error(`❌ /help error: ${err.message}`); await replyError(interaction, now, `\`${err.message}\``); } }

    // ── /mode ──────────────────────────────────────────────
    else if (interaction.commandName === 'mode') { try {
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
        const kwList = (keywords.map((k, i) => `> \`${String(i + 1).padStart(2, '0')}.\` ${k}`).join('\n') || '> *No keywords set*').slice(0, 1024);

        await interaction.reply({
            embeds: [new EmbedBuilder()
                .setColor(modeColor)
                .setAuthor({ name: 'Pinterest Bot — Mode Changed', iconURL: interaction.client.user.displayAvatarURL() })
                .setThumbnail(interaction.client.user.displayAvatarURL())
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
                    .setThumbnail(interaction.client.user.displayAvatarURL())
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
                .setThumbnail(interaction.client.user.displayAvatarURL())
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
        const kwList    = (keywords.map((k, i) => `> \`${String(i + 1).padStart(2, '0')}.\` ${k}`).join('\n') || '> *No keywords set*').slice(0, 1024);

        await interaction.reply({
            embeds: [new EmbedBuilder()
                .setColor('#E60023')
                .setAuthor({ name: 'Pinterest Bot — Keywords', iconURL: interaction.client.user.displayAvatarURL() })
                .setThumbnail(interaction.client.user.displayAvatarURL())
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
        const kw  = interaction.options.getString('keyword');
        const idx = keywords.indexOf(kw);

        if (idx === -1) {
            return interaction.reply({
                embeds: [new EmbedBuilder()
                    .setColor('#ED4245')
                    .setAuthor({ name: 'Pinterest Bot — Error', iconURL: interaction.client.user.displayAvatarURL() })
                    .setThumbnail(interaction.client.user.displayAvatarURL())
                    .setTitle('❌  Keyword not found')
                    .setDescription(`\`${kw}\` is not in the current list.`)
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
                    .setThumbnail(interaction.client.user.displayAvatarURL())
                    .setTitle('⚠️  Cannot remove last keyword')
                    .setDescription('At least one keyword must remain in the list.')
                    .setFooter({ text: `Requested by ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() })
                    .setTimestamp(now)
                ],
                ephemeral: true
            });
        }

        keywords.splice(idx, 1);
        if (_keywordIndex > 0) _keywordIndex = Math.min(_keywordIndex, keywords.length - 1);
        delete keywordBookmarks[kw];
        imageQueue = imageQueue.filter(item => item.keyword !== kw);
        saveState();

        const kwList = (keywords.map((k, i) => `> \`${String(i + 1).padStart(2, '0')}.\` ${k}`).join('\n') || '> *No keywords set*').slice(0, 1024);

        await interaction.reply({
            embeds: [new EmbedBuilder()
                .setColor('#ED4245')
                .setAuthor({ name: 'Pinterest Bot — Keyword Removed', iconURL: interaction.client.user.displayAvatarURL() })
                .setThumbnail(interaction.client.user.displayAvatarURL())
                .setTitle('🗑️  Keyword removed')
                .addFields(
                    { name: '❌  Removed',   value: `\`${kw}\``,           inline: true },
                    { name: '📊  Remaining', value: `${keywords.length}`,   inline: true },
                    { name: '─────────────────', value: kwList }
                )
                .setFooter({ text: `Requested by ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() })
                .setTimestamp(now)
            ],
            ephemeral: true
        });
    } catch (err) { console.error(`❌ /removekeyword error: ${err.message}`); await replyError(interaction, now, `\`${err.message}\``); } }

    // ── /expandkeyword ─────────────────────────────────────
    else if (interaction.commandName === 'expandkeyword') { try {
        autoExpand = !autoExpand;
        saveState();

        const isOn     = autoExpand;
        const color    = isOn ? '#57F287' : '#ED4245';
        const emoji    = isOn ? '✅' : '❌';
        const label    = isOn ? 'Enabled' : 'Disabled';
        const desc     = isOn
            ? 'The bot will automatically discover Pinterest Guided Search variants and add them on every fetch cycle.'
            : 'The bot will not auto-expand keywords — it works only on the keywords already in the list.';

        await interaction.reply({
            embeds: [new EmbedBuilder()
                .setColor(color)
                .setAuthor({ name: 'Pinterest Bot — Auto-Expand', iconURL: interaction.client.user.displayAvatarURL() })
                .setThumbnail(interaction.client.user.displayAvatarURL())
                .setTitle(`${emoji}  Auto-Expand ${label}`)
                .setDescription(desc)
                .addFields(
                    { name: '🔍  Status',  value: label,              inline: true },
                    { name: '📊  Keywords', value: `${keywords.length}`, inline: true },
                )
                .setFooter({ text: `Requested by ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() })
                .setTimestamp(now)
            ],
            ephemeral: true
        });
    } catch (err) { console.error(`❌ /expandkeyword error: ${err.message}`); await replyError(interaction, now, `\`${err.message}\``); } }

    // ── /editkeyword ──────────────────────────────────────
    else if (interaction.commandName === 'editkeyword') { try {
        const oldKw = interaction.options.getString('keyword');
        const newKw = interaction.options.getString('newkeyword').trim();
        const idx   = keywords.indexOf(oldKw);

        if (idx === -1) {
            return interaction.reply({
                embeds: [new EmbedBuilder()
                    .setColor('#ED4245')
                    .setAuthor({ name: 'Pinterest Bot — Error', iconURL: interaction.client.user.displayAvatarURL() })
                    .setThumbnail(interaction.client.user.displayAvatarURL())
                    .setTitle('❌  Keyword not found')
                    .setDescription(`\`${oldKw}\` is not in the current list.`)
                    .setFooter({ text: `Requested by ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() })
                    .setTimestamp(now)
                ],
                ephemeral: true
            });
        }

        if (oldKw === newKw) {
            return interaction.reply({
                embeds: [new EmbedBuilder()
                    .setColor('#FEE75C')
                    .setAuthor({ name: 'Pinterest Bot — No Change', iconURL: interaction.client.user.displayAvatarURL() })
                    .setThumbnail(interaction.client.user.displayAvatarURL())
                    .setTitle('⚠️  Same keyword')
                    .setDescription(`The new keyword is identical to the current one — no changes made.`)
                    .setFooter({ text: `Requested by ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() })
                    .setTimestamp(now)
                ],
                ephemeral: true
            });
        }

        if (keywords.includes(newKw)) {
            return interaction.reply({
                embeds: [new EmbedBuilder()
                    .setColor('#FEE75C')
                    .setAuthor({ name: 'Pinterest Bot — Duplicate', iconURL: interaction.client.user.displayAvatarURL() })
                    .setThumbnail(interaction.client.user.displayAvatarURL())
                    .setTitle('⚠️  Keyword already exists')
                    .setDescription(`\`${newKw}\` is already in the list at another position — no changes made.`)
                    .setFooter({ text: `Requested by ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() })
                    .setTimestamp(now)
                ],
                ephemeral: true
            });
        }

        // Replace the keyword in-place (same slot number)
        keywords[idx] = newKw;

        // Clean up state tied to the old keyword
        delete keywordBookmarks[oldKw];
        delete guidedCache[oldKw];
        imageQueue = imageQueue.filter(item => item.keyword !== oldKw);

        saveState();

        // Pre-fetch new keyword in background
        fetchOneKeyword(newKw).then(n => {
            if (n > 0) { saveState(); console.log(`  ✅ Pre-fetched ${n} from edited keyword "${newKw}"`); }
        }).catch(() => {});

        const kwList = keywords.map((k, i) => `> \`${String(i + 1).padStart(2, '0')}.\` ${k}${i === idx ? '  ← **edited**' : ''}`).join('\n').slice(0, 1024);

        await interaction.reply({
            embeds: [new EmbedBuilder()
                .setColor('#5865F2')
                .setAuthor({ name: 'Pinterest Bot — Keyword Edited', iconURL: interaction.client.user.displayAvatarURL() })
                .setThumbnail(interaction.client.user.displayAvatarURL())
                .setTitle('✏️  Keyword updated')
                .addFields(
                    { name: '❌  Old',  value: `\`${oldKw}\``,        inline: true },
                    { name: '✅  New',  value: `\`${newKw}\``,        inline: true },
                    { name: '🔢  Slot', value: `#${idx + 1}`,         inline: true },
                    { name: '📋  Full list', value: kwList }
                )
                .setFooter({ text: `Requested by ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() })
                .setTimestamp(now)
            ],
            ephemeral: true
        });
    } catch (err) { console.error(`❌ /editkeyword error: ${err.message}`); await replyError(interaction, now, `\`${err.message}\``); } }
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
