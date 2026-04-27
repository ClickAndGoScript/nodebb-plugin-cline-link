'use strict';

const db = require.main.require('./src/database');
const meta = require.main.require('./src/meta');
const posts = require.main.require('./src/posts');
const topics = require.main.require('./src/topics');
const users = require.main.require('./src/user');
const websockets = require.main.require('./src/socket.io');
const AliExpressService = require('./aliexpress');

const plugin = {};

const ADMIN_UIDS = [1, 2];
const WHITELIST_DB_KEY = 'plugin:cline-links:whitelist';

// מפתחות DB עבור state של עיבוד הפוסט.
// state: 'pending' (עיבוד טרם הסתיים) | 'clean' (אין שינוי) | 'modified' (יש החלפות).
// כשהמצב 'modified', המפתח replacements מכיל JSON של מפת original→final.
const stateKey = (pid) => `plugin:cline-links:post:${pid}:state`;
const replacementsKey = (pid) => `plugin:cline-links:post:${pid}:replacements`;
const PENDING_INDEX_KEY = 'plugin:cline-links:pending'; // set של pids עם state=pending (לניקוי בעלייה)

const POLL_INTERVAL_MS = 200;
const POLL_TIMEOUT_MS = 10000;

const BLACKLISTED_PARAMS = [
    'spm', 'aff_id', 'aff_platform', 'aff_trace_key', 'tag', 'ref',
    '_x_cid', '_x_ads_channel', '_x_campaign', '_x_vst_scene',
    'refer_share_id', 'refer_share_uid', 'invite_code',
    'linkCode', 'ref_', 'creative', 'camp', 'collection_id',
    'pdp_npi', 'gps-id', 'scm', 'ws_ab_test', 'pdp_ext_f', 'sourceType'
];

const WHITELISTED_PARAMS = [
    'productIds', 'bundle_id', 'g_site', 'g_region', 'g_lg', 'g_ccy', 'subj'
];

const CLEANING_RULES = [
    {
        name: 'Short Links',
        regex: /https?:\/\/(?:s\.click\.aliexpress\.com|a\.aliexpress\.com|temu\.to|share\.temu\.com|amzn\.to|ebay\.to)\/[^\s)]+/g,
        resolve: true,
        isAliExpress: true
    },
    {
        name: 'AliExpress Direct',
        regex: /https?:\/\/(?:\w+\.)?aliexpress\.com\/(?:item\/|ssr\/|store\/|p\/)[^\s)]+/g,
        resolve: false,
        isAliExpress: true
    },
    {
        name: 'Temu Direct',
        regex: /https?:\/\/(?:\w+\.)?temu\.com\/[^\s)]+/g,
        resolve: false,
        isAliExpress: false
    },
    {
        name: 'Amazon Direct',
        regex: /https?:\/\/(?:\w+\.)?amazon\.(?:com|co\.uk|de|it|fr|es|ca)\/(?:dp|gp\/product)\/[\w\d]+[^\s)]*/g,
        resolve: false,
        isAliExpress: false
    }
];

plugin.init = async function (params) {
    console.log('[cline-links] ✅ Plugin init() called - hooks should be registered');
    const { router, middleware } = params;
    router.get('/admin/plugins/cline-links', middleware.admin.buildHeader, plugin.renderAdmin);
    router.get('/api/admin/plugins/cline-links', plugin.renderAdmin);

    // ניקוי pending תקוע מ-crash קודם: כל פוסט שנשאר ב-pending לא יסיים לעולם
    // ויחסום את המייל עד timeout. נסיר את הסימון כדי שהמיילים ייצאו (עם תוכן מ-DB,
    // שייתכן שלא עובד, אבל זו הברירה הטובה יותר ממילא תקוע).
    try {
        const stuckPids = await db.getSetMembers(PENDING_INDEX_KEY);
        if (stuckPids && stuckPids.length) {
            console.log(`[cline-links] 🧹 cleaning up ${stuckPids.length} stuck pending pids from previous run`);
            await Promise.all(stuckPids.map(async (pid) => {
                await db.delete(stateKey(pid));
                await db.setRemove(PENDING_INDEX_KEY, pid);
            }));
        }
    } catch (err) {
        console.error('[cline-links] init cleanup error:', err);
    }
};

plugin.renderAdmin = function (req, res) {
    res.render('admin/plugins/cline-links', { title: 'Cline Links & Affiliate' });
};

plugin.addAdminNavigation = async function (header) {
    header.plugins.push({ route: '/plugins/cline-links', icon: 'fa-shopping-cart', name: 'Cline Links' });
    return header;
};

// קיצור-דרך לתהליך הנוכחי: אם העיבוד רץ באותו תהליך, ה-email hook יכול
// לחכות ישירות ל-Promise במקום polling ל-DB. בקונפיגורציית multi-process,
// תהליך אחר יזדקק ל-polling — וזה בסדר.
const inFlight = new Map();

async function markPending(pid) {
    await Promise.all([
        db.set(stateKey(pid), 'pending'),
        db.setAdd(PENDING_INDEX_KEY, String(pid)),
        db.delete(replacementsKey(pid)),
    ]);
}

async function markFinished(pid, replacements) {
    const hasChanges = replacements && replacements.size > 0;
    if (hasChanges) {
        const obj = {};
        for (const [orig, final] of replacements) obj[orig] = final;
        await db.setObject(replacementsKey(pid), obj);
        await db.set(stateKey(pid), 'modified');
    } else {
        await db.delete(replacementsKey(pid));
        await db.set(stateKey(pid), 'clean');
    }
    await db.setRemove(PENDING_INDEX_KEY, String(pid));
}

async function getState(pid) {
    return await db.get(stateKey(pid));
}

async function getReplacements(pid) {
    const obj = await db.getObject(replacementsKey(pid));
    if (!obj) return null;
    return new Map(Object.entries(obj));
}

function startProcessing(pid) {
    if (!pid) return null;
    const key = String(pid);
    if (inFlight.has(key)) return inFlight.get(key);
    const p = (async () => {
        let result = { replacements: new Map() };
        try {
            // Safety net: ב-filter:post.create ייתכן שה-pid עוד לא היה זמין
            // ולכן markPending לא רץ. נסמן כאן ליתר ביטחון, לפני העיבוד עצמו.
            try { await markPending(pid); }
            catch (err) { console.error('[cline-links] markPending in startProcessing error:', err); }
            result = await processPostContent(pid);
        } finally {
            try { await markFinished(pid, result.replacements); }
            catch (err) { console.error('[cline-links] markFinished error:', err); }
        }
        return result;
    })().finally(() => { if (inFlight.get(key) === p) inFlight.delete(key); });
    inFlight.set(key, p);
    return p;
}

// Hooks: filter:post.create / filter:post.edit רצים *לפני* שמירת הפוסט.
// אנחנו מסמנים pending כאן כדי שאם ה-email hook נורה לפני ש-post.save הסתיים,
// הוא ימצא את הסימון ויחכה.
plugin.handlePostFilter = async (data) => {
    const pid = data?.post?.pid;
    if (pid) {
        try { await markPending(pid); }
        catch (err) { console.error('[cline-links] markPending error:', err); }
    }
    return data;
};

plugin.handlePostSave = (data) => {
    console.log('[cline-links] 🔔 handlePostSave fired, pid=', data?.post?.pid, 'hasContent=', !!data?.post?.content);
    if (data?.post?.pid) setImmediate(() => startProcessing(data.post.pid));
};
plugin.handlePostEdit = (data) => {
    console.log('[cline-links] 🔔 handlePostEdit fired, pid=', data?.post?.pid, 'hasContent=', !!data?.post?.content);
    if (data?.post?.pid) setImmediate(() => startProcessing(data.post.pid));
};

async function waitForState(pid) {
    // קיצור-דרך לתהליך הנוכחי
    const local = inFlight.get(String(pid));
    if (local) {
        try { await local; } catch (_) { /* state ב-DB יספר את הסיפור */ }
    }
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const state = await getState(pid);
        if (state !== 'pending') return state; // 'clean' | 'modified' | null
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    console.warn(`[cline-links] ⏱️ waitForState timeout for pid=${pid}`);
    return await getState(pid); // נחזיר את מה שיש, גם אם עדיין pending
}

plugin.handleEmailParams = async (params) => {
    console.log(params)
    try {
        const pid = parseInt(params?.pid ?? params?.notification?.pid, 10);
        if (!pid) return params;

        const state = await waitForState(pid);
        // 'clean' או null/לא-מסומן → אין מה להחליף, יוצאים מיד (קריאת DB אחת).
        if (state !== 'modified') return params;

        const replacements = await getReplacements(pid);
        if (!replacements || replacements.size === 0) return params;

        const apply = (text) => {
            if (typeof text !== 'string' || !text) return text;
            let out = text;
            for (const [orig, final] of replacements) {
                if (orig === final) continue;
                const escaped = orig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                out = out.replace(new RegExp(escaped, 'g'), final);
            }
            return out;
        };

        if (params.body) params.body = apply(params.body);
        if (params.intro) params.intro = apply(params.intro);
        if (params.notification) {
            if (params.notification.bodyShort) params.notification.bodyShort = apply(params.notification.bodyShort);
            if (params.notification.bodyLong) params.notification.bodyLong = apply(params.notification.bodyLong);
            if (params.notification.bodyEmail) params.notification.bodyEmail = apply(params.notification.bodyEmail);
        }
    } catch (err) {
        console.error('[cline-links] handleEmailParams error:', err);
    }
    return params;
};

async function processPostContent(pid) {
    console.log(`[cline-links] ▶️ processPostContent START pid=${pid}`);
    const replacements = new Map();
    try {
        const postData = await posts.getPostData(pid);
        if (!postData || !postData.content) {
            console.log(`[cline-links] ⛔ pid=${pid} no postData/content, postData=${!!postData}`);
            return { replacements };
        }
        console.log(`[cline-links] 📄 pid=${pid} content length=${postData.content.length}, uid=${postData.uid}`);
        console.log(`[cline-links] 📄 pid=${pid} content preview:`, postData.content.substring(0, 300));

        const settings = await meta.settings.get('cline-links');
        const enabled = settings && settings.enabled === 'on';
        const postOwnerUid = parseInt(postData.uid, 10);
        console.log(`[cline-links] ⚙️ settings enabled=${enabled}, raw settings=`, JSON.stringify(settings));

        let currentContent = postData.content;
        let modified = false;

        let matches = [];
        for (const rule of CLEANING_RULES) {
            const found = currentContent.match(rule.regex);
            console.log(`[cline-links] 🔍 rule "${rule.name}" matches=${found ? found.length : 0}`);
            if (found) found.forEach(url => matches.push({ url, rule }));
        }

        if (matches.length === 0) {
            console.log(`[cline-links] ⛔ pid=${pid} no matching URLs found, returning`);
            return { replacements };
        }
        console.log(`[cline-links] ✅ pid=${pid} total matches=${matches.length}`);

        const uniqueLinks = [...new Set(matches.map(m => m.url))];
        const aliService = new AliExpressService(settings);

        for (const originalUrl of uniqueLinks) {
            const normalizedOriginal = normalizeUrl(originalUrl);
            console.log(`[cline-links] 🔗 processing URL: ${normalizedOriginal}`);

            // בדיקה: האם הקישור הזה הוא כבר קישור "מוסכם" (הומר בעבר ע"י הפורום)
            if (await db.isSetMember(WHITELIST_DB_KEY, normalizedOriginal)) {
                console.log(`[cline-links] Whitelist hit: skipping ${normalizedOriginal}`);
                continue;
            }

            const match = matches.find(m => m.url === originalUrl);
            let workUrl = normalizedOriginal;
            let wasConverted = false;

            // 1. Resolve (רק אם לא מולבן)
            if (match.rule.resolve) {
                workUrl = await resolveShortLink(workUrl);
                console.log(`[cline-links] 🔁 resolved to: ${workUrl}`);
            }

            // 2. Strip Parameters
            let finalUrl = stripAffiliateParameters(workUrl);
            console.log(`[cline-links] 🧹 after strip: ${finalUrl}`);

            // 3. AliExpress API Conversion
            if (enabled && (match.rule.isAliExpress || finalUrl.includes('aliexpress.com'))) {
                const subId = postOwnerUid > 0 ? `u${postOwnerUid}` : 'guest';
                console.log(`[cline-links] 💱 calling AliExpress API, subId=${subId}, url=${finalUrl}`);
                const affiliateUrl = await aliService.convertToAffiliate(finalUrl, subId);
                console.log(`[cline-links] 💱 API returned: ${affiliateUrl}`);
                if (affiliateUrl) {
                    finalUrl = affiliateUrl;
                    wasConverted = true;
                }
            } else {
                console.log(`[cline-links] ⏭️ skipping AliExpress conversion (enabled=${enabled}, isAli=${match.rule.isAliExpress}, containsAli=${finalUrl.includes('aliexpress.com')})`);
            }

            // 4. הלבנה: אנחנו שומרים את התוצאה הסופית ברשימה הלבנה
            // אם זה קישור מקוצר (s.click) שנוצר עכשיו, הוא לא יעובד שוב לעולם.
            if (wasConverted || match.rule.resolve) {
                await db.setAdd(WHITELIST_DB_KEY, normalizeUrl(finalUrl));
            }

            // 5. החלפה
            if (finalUrl !== originalUrl) {
                const escaped = originalUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                currentContent = currentContent.replace(new RegExp(escaped, 'g'), finalUrl);
                modified = true;
                replacements.set(originalUrl, finalUrl);
            }
        }

        if (modified) {
            console.log(`[cline-links] 💾 saving pid=${pid}, new content preview:`, currentContent.substring(0, 300));
            await posts.setPostField(pid, 'content', currentContent);
            await posts.clearCachedPost(pid);

            const verifyData = await posts.getPostData(pid);
            console.log(`[cline-links] ✅ verify after save pid=${pid}, stored content preview:`, verifyData?.content?.substring(0, 300));

            // בנייה מדויקת של אובייקט ה-Socket לפי הדוגמה התקינה
            const [topicData, userData, parsedPost] = await Promise.all([
                topics.getTopicData(postData.tid),
                users.getUserFields(postOwnerUid, ['username', 'userslug', 'displayname']),
                posts.parsePost({ ...postData, content: currentContent })
            ]);

            const isMainPost = parseInt(pid, 10) === parseInt(topicData.mainPid, 10);

            // אובייקט ה-Topic המצומצם שמופיע פעמיים
            const simpleTopic = {
                tid: parseInt(topicData.tid, 10),
                cid: parseInt(topicData.cid, 10),
                title: topicData.title,
                isMainPost: isMainPost,
                renamed: false,
                tagsupdated: false
            };

            const editResult = {
                topic: simpleTopic,
                editor: {
                    username: userData.username,
                    userslug: userData.userslug,
                    uid: postOwnerUid,
                    displayname: userData.displayname,
                    isLocal: true
                },
                post: {
                    content: parsedPost.content, // ה-HTML המעובד
                    pid: parseInt(pid, 10),
                    tid: parseInt(postData.tid, 10),
                    uid: postOwnerUid,
                    timestamp: postData.timestamp,
                    timestampISO: new Date(postData.timestamp).toISOString(),
                    deleted: false,
                    upvotes: 0,
                    downvotes: 0,
                    deleterUid: 0,
                    replies: 0,
                    bookmarks: 0,
                    votes: 0,
                    cid: parseInt(topicData.cid, 10),
                    editor: postOwnerUid,
                    topic: simpleTopic, // חייב להופיע גם פה
                    changed: true // חייב להופיע בתוך הפוסט
                }
            };


            websockets.in(`topic_${postData.tid}`).emit('event:post_edited', editResult);
            console.log(`[cline-links] Broadcasted exact structure for PID ${pid}`);

        }

    } catch (err) {
        console.error('[cline-links] Error:', err);
    }
    return { replacements };
}

function normalizeUrl(url) {
    return url ? url.replace(/[).,;!]+$/, '').trim() : '';
}

function stripAffiliateParameters(url) {
    try {
        const urlObj = new URL(normalizeUrl(url));
        const params = urlObj.searchParams;
        const keys = Array.from(params.keys());

        keys.forEach(key => {
            if (BLACKLISTED_PARAMS.includes(key) || key.startsWith('_x_')) {
                params.delete(key);
            } else if (
                (urlObj.pathname.includes('/item/') || urlObj.pathname.includes('/ssr/') || urlObj.pathname.includes('/dp/')) &&
                !WHITELISTED_PARAMS.includes(key)
            ) {
                params.delete(key);
            }
        });
        return urlObj.toString();
    } catch (e) {
        return url;
    }
}

async function resolveShortLink(url) {
    try {
        const response = await fetch(url, {
            method: 'GET',
            redirect: 'follow',
            headers: { 'User-Agent': 'Mozilla/5.0' },
            signal: AbortSignal.timeout(5000)
        });
        return response.url;
    } catch (err) {
        return url;
    }
}

module.exports = plugin;