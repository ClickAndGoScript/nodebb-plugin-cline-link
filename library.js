'use strict';

const db = require.main.require('./src/database');
const meta = require.main.require('./src/meta');
const posts = require.main.require('./src/posts');
const topics = require.main.require('./src/topics');
const users = require.main.require('./src/user');
const websockets = require.main.require('./src/socket.io');
const messaging = require.main.require('./src/messaging');
const AliExpressService = require('./aliexpress');

const plugin = {};

const ADMIN_UIDS = [1, 2];
const WHITELIST_DB_KEY = 'plugin:cline-links:whitelist';

// מפתחות DB עבור state של עיבוד פוסט.
// state: 'pending' (עיבוד טרם הסתיים) | 'clean' (אין שינוי) | 'modified' (יש החלפות).
// כשהמצב 'modified', המפתח replacements מכיל JSON של מפת original→final.
const stateKey = (pid) => `plugin:cline-links:post:${pid}:state`;
const replacementsKey = (pid) => `plugin:cline-links:post:${pid}:replacements`;
const PENDING_INDEX_KEY = 'plugin:cline-links:pending'; // set של pids עם state=pending (לניקוי בעלייה)

// עבור הודעות צ'אט: אין ל-NodeBB מזהה הודעה (mid) בתוך אובייקט ההתראה שנשלח
// למייל - יש רק roomId. לכן שומרים את ההחלפות פר-חדר (מצטבר, לעולם לא נמחק),
// ומעקב ה-pending הוא סט של mid-ים שעדיין בעיבוד באותו חדר - לא state יחיד,
// כי כמה הודעות יכולות להיות בעיבוד באותו חדר בו-זמנית.
const roomPendingKey = (roomId) => `plugin:cline-links:room:${roomId}:pending`;
const roomReplacementsKey = (roomId) => `plugin:cline-links:room:${roomId}:replacements`;
const ROOM_PENDING_INDEX_KEY = 'plugin:cline-links:room-pending'; // set של "roomId:mid" (לניקוי בעלייה)

const POLL_INTERVAL_MS = 200;
const POLL_TIMEOUT_MS = 10000;

const BLACKLISTED_PARAMS = [
    'spm', 'aff_id', 'aff_platform', 'aff_trace_key', 'tag', 'ref',
    '_x_cid', '_x_ads_channel', '_x_campaign', '_x_vst_scene',
    'refer_share_id', 'refer_share_uid', 'invite_code',
    'linkCode', 'ref_', 'creative', 'camp', 'collection_id',
    'pdp_npi', 'gps-id', 'scm', 'ws_ab_test', 'sourceType'
];

// sku_id/skuId/pdp_ext_f מזהים את הוריאציה (למשל צבע) שנבחרה באותו item id -
// ר' AliExpress Color Link Copier. גם אם ה-API של השותפים מחזיר קישור בלי
// הפרמטר הזה בכל מקרה, התוסף עצמו לא אמור להסיר אותו.
const WHITELISTED_PARAMS = [
    'productIds', 'bundle_id', 'g_site', 'g_region', 'g_lg', 'g_ccy', 'subj',
    'sku_id', 'skuId', 'pdp_ext_f'
];

const CLEANING_RULES = [
    {
        name: 'Short Links',
        regex: /(?:https?:\/\/)?(?:s\.click\.aliexpress\.com|a\.aliexpress\.com|temu\.to|share\.temu\.com|amzn\.to|ebay\.to)\/[^\s)]+/g,
        resolve: true,
        isAliExpress: true
    },
    {
        name: 'AliExpress Direct',
        regex: /(?:https?:\/\/)?(?:\w+\.)?aliexpress\.com\/(?:item\/|ssr\/|store\/|p\/)[^\s)]+/g,
        resolve: false,
        isAliExpress: true
    },
    {
        name: 'Temu Direct',
        regex: /(?:https?:\/\/)?(?:\w+\.)?temu\.com\/[^\s)]+/g,
        resolve: false,
        isAliExpress: false
    },
    {
        name: 'Amazon Direct',
        regex: /(?:https?:\/\/)?(?:\w+\.)?amazon\.(?:com|co\.uk|de|it|fr|es|ca)\/(?:dp|gp\/product)\/[\w\d]+[^\s)]*/g,
        resolve: false,
        isAliExpress: false
    }
];

plugin.init = async function (params) {
    // console.log('[cline-links] ✅ Plugin init() called - hooks should be registered');
    const { router, middleware } = params;
    router.get('/admin/plugins/cline-links', middleware.admin.buildHeader, plugin.renderAdmin);
    router.get('/api/admin/plugins/cline-links', plugin.renderAdmin);

    // ניקוי pending תקוע מ-crash קודם: כל פריט שנשאר ב-pending לא יסיים לעולם
    // ויחסום את המייל עד timeout. נסיר את הסימון כדי שהמיילים ייצאו (עם תוכן מ-DB,
    // שייתכן שלא עובד, אבל זו הברירה הטובה יותר ממילא תקוע).
    try {
        const stuckPids = await db.getSetMembers(PENDING_INDEX_KEY);
        if (stuckPids && stuckPids.length) {
            await Promise.all(stuckPids.map(async (pid) => {
                await db.delete(stateKey(pid));
                await db.setRemove(PENDING_INDEX_KEY, pid);
            }));
        }

        const stuckRoomMids = await db.getSetMembers(ROOM_PENDING_INDEX_KEY);
        if (stuckRoomMids && stuckRoomMids.length) {
            await Promise.all(stuckRoomMids.map(async (entry) => {
                const sep = entry.indexOf(':');
                const roomId = entry.slice(0, sep);
                const mid = entry.slice(sep + 1);
                await db.setRemove(roomPendingKey(roomId), mid);
                await db.setRemove(ROOM_PENDING_INDEX_KEY, entry);
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
const inFlight = new Map(); // pid -> Promise (עיבוד פוסט יחיד)
const roomInFlight = new Map(); // roomId -> Set<Promise> (כמה הודעות יכולות להיות בעיבוד באותו חדר בו-זמנית)

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
    // console.log('[cline-links] 🔔 handlePostSave fired, pid=', data?.post?.pid, 'hasContent=', !!data?.post?.content);
    if (data?.post?.pid) setImmediate(() => startProcessing(data.post.pid));
};
plugin.handlePostEdit = (data) => {
    // console.log('[cline-links] 🔔 handlePostEdit fired, pid=', data?.post?.pid, 'hasContent=', !!data?.post?.content);
    if (data?.post?.pid) setImmediate(() => startProcessing(data.post.pid));
};

// --- הודעות צ'אט ---
// בניגוד לפוסטים, אין ל-NodeBB "pid" מקביל בתוך אובייקט ההתראה של צ'אט - אבל
// roomId כן קיים תמיד. לכן ההחלפות נשמרות פר-חדר (מצטבר), וה-pending הוא סט
// של mid-ים בעיבוד באותו חדר, כדי שכמה הודעות באותו חדר לא ידרסו זו את זו.
async function markMessagePending(roomId, mid) {
    await Promise.all([
        db.setAdd(roomPendingKey(roomId), String(mid)),
        db.setAdd(ROOM_PENDING_INDEX_KEY, `${roomId}:${mid}`),
    ]);
}

async function markMessageFinished(roomId, mid, replacements) {
    if (replacements && replacements.size > 0) {
        const obj = {};
        for (const [orig, final] of replacements) obj[orig] = final;
        await db.setObject(roomReplacementsKey(roomId), obj); // מצטרף למפה הקיימת של החדר, לא דורס
    }
    await db.setRemove(roomPendingKey(roomId), String(mid));
    await db.setRemove(ROOM_PENDING_INDEX_KEY, `${roomId}:${mid}`);
}

function startProcessingMessage(message) {
    const { roomId, mid } = message;
    const p = (async () => {
        let result = { replacements: new Map() };
        try {
            try { await markMessagePending(roomId, mid); }
            catch (err) { console.error('[cline-links] markMessagePending error:', err); }
            result = await processMessageContent(message);
        } finally {
            try { await markMessageFinished(roomId, mid, result.replacements); }
            catch (err) { console.error('[cline-links] markMessageFinished error:', err); }
        }
        return result;
    })();
    let set = roomInFlight.get(roomId);
    if (!set) { set = new Set(); roomInFlight.set(roomId, set); }
    set.add(p);
    p.finally(() => { set.delete(p); if (set.size === 0) roomInFlight.delete(roomId); });
    return p;
}

// filter:messaging.save רץ *לפני* שההודעה נשמרת, ו-NodeBB ממתין לו (await).
// מסמנים pending כאן - בדיוק כמו handlePostFilter אצל פוסטים - כדי שכשה-email
// hook (שנשלף מ-notifyUsersInRoom, שרץ מיד אחרי שההודעה נשמרת) יבדוק, הסימון
// יהיה כבר ב-DB. בלי זה יש חלון-זמן שבו ההודעה נשמרה אבל אנחנו עדיין לא סימנו
// pending (כי action:messaging.save+setImmediate רצים אחרי), וה-email "מפספס"
// את ההמתנה ומקבל את הקישור הגולמי.
plugin.handleMessageFilter = async (message) => {
    if (message?.mid && message?.roomId) {
        try { await markMessagePending(message.roomId, message.mid); }
        catch (err) { console.error('[cline-links] markMessagePending (filter) error:', err); }
    }
    return message;
};

// action:messaging.save נורה אחרי שההודעה כבר נשמרה - כאן מריצים את העיבוד
// הכבד (resolve/API) ברקע, בלי לחסום את שליחת ההודעה.
plugin.handleMessageSave = (data) => {
    const message = data?.message;
    if (message?.mid && message?.roomId) {
        setImmediate(() => startProcessingMessage(message));
    }
};

async function processMessageContent(message) {
    const replacements = new Map();
    try {
        if (!message || !message.content || !message.mid) return { replacements };

        const settings = await meta.settings.get('cline-links');
        const ownerUid = parseInt(message.fromuid, 10);
        const aliService = new AliExpressService(settings);

        const result = await findAndReplaceLinks(message.content, ownerUid, settings, aliService);
        if (!result.modified) return { replacements };
        for (const [orig, final] of result.replacements) replacements.set(orig, final);

        await messaging.editMessage(message.fromuid, message.mid, message.roomId, result.content);
    } catch (err) {
        console.error('[cline-links] processMessageContent error:', err);
    }
    return { replacements };
}

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

// ממתין לכל העיבודים שרצים כרגע על החדר (קיצור-דרך לתהליך הנוכחי), ואז בודק
// את סט ה-pending ב-DB עד timeout - כדי לכסות גם multi-process וגם עיבודים
// שהתחילו אחרי הקריאה הראשונה. תמיד מחזיר את מפת ההחלפות המצטברת של החדר,
// גם אם עדיין נשארו mid-ים pending (עדיף חלק מההחלפות מאשר לחכות לנצח).
async function waitForRoom(roomId) {
    const local = roomInFlight.get(roomId);
    if (local && local.size) {
        try { await Promise.allSettled([...local]); } catch (_) { /* לא אמור לקרות, allSettled לא נכשל */ }
    }
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const pending = await db.getSetMembers(roomPendingKey(roomId));
        if (!pending || pending.length === 0) break;
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    return await getRoomReplacements(roomId);
}

async function getRoomReplacements(roomId) {
    const obj = await db.getObject(roomReplacementsKey(roomId));
    if (!obj) return null;
    return new Map(Object.entries(obj));
}

plugin.handleEmailParams = async (data) => {
    try {
        // ה-hook מקבל מעטפת: { template, email, language, params, caller }.
        // הפרמטרים האמיתיים של התבנית נמצאים ב-data.params.
        const inner = data?.params || {};
        const pid = parseInt(inner.pid ?? inner.notification?.pid, 10);
        const roomId = inner.notification?.roomId;

        let replacements;
        if (pid) {
            const state = await waitForState(pid);
            // 'clean' או null/לא-מסומן → אין מה להחליף, יוצאים מיד (קריאת DB אחת).
            if (state !== 'modified') return data;
            replacements = await getReplacements(pid);
        } else if (roomId) {
            replacements = await waitForRoom(roomId);
        } else {
            return data;
        }

        if (!replacements || replacements.size === 0) return data;

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

        if (inner.body) inner.body = apply(inner.body);
        if (inner.intro) inner.intro = apply(inner.intro);
        if (inner.subject) inner.subject = apply(inner.subject);
        if (inner.notification) {
            if (inner.notification.bodyShort) inner.notification.bodyShort = apply(inner.notification.bodyShort);
            if (inner.notification.bodyLong) inner.notification.bodyLong = apply(inner.notification.bodyLong);
            if (inner.notification.bodyEmail) inner.notification.bodyEmail = apply(inner.notification.bodyEmail);
            if (inner.notification.subject) inner.notification.subject = apply(inner.notification.subject);
        }
    } catch (err) {
        console.error('[cline-links] handleEmailParams error:', err);
    }
    return data;
};

// לוגיקת הזיהוי/ניקוי/המרה המשותפת לפוסטים ולהודעות צ'אט.
async function findAndReplaceLinks(content, ownerUid, settings, aliService) {
    const replacements = new Map();
    const enabled = settings && settings.enabled === 'on';
    let currentContent = content;
    let modified = false;

    let matches = [];
    for (const rule of CLEANING_RULES) {
        const found = currentContent.match(rule.regex);
        if (found) found.forEach(url => matches.push({ url, rule }));
    }

    if (matches.length === 0) {
        return { content: currentContent, modified, replacements };
    }

    const uniqueLinks = [...new Set(matches.map(m => m.url))];

    for (const originalUrl of uniqueLinks) {
        const normalizedOriginal = normalizeUrl(originalUrl);

        // בדיקה: האם הקישור הזה הוא כבר קישור "מוסכם" (הומר בעבר ע"י הפורום)
        if (await db.isSetMember(WHITELIST_DB_KEY, normalizedOriginal)) {
            continue;
        }

        const match = matches.find(m => m.url === originalUrl);
        let workUrl = normalizedOriginal;
        let wasConverted = false;

        // 1. Resolve (רק אם לא מולבן)
        if (match.rule.resolve) {
            workUrl = await resolveShortLink(workUrl);
        }

        // 2. Strip Parameters
        let finalUrl = stripAffiliateParameters(workUrl);

        // 3. AliExpress API Conversion
        if (enabled && (match.rule.isAliExpress || finalUrl.includes('aliexpress.com'))) {
            const subId = ownerUid > 0 ? `u${ownerUid}` : 'guest';
            const affiliateUrl = await aliService.convertToAffiliate(finalUrl, subId);
            if (affiliateUrl) {
                finalUrl = affiliateUrl;
                wasConverted = true;
            }
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

    return { content: currentContent, modified, replacements };
}

async function processPostContent(pid) {
    // console.log(`[cline-links] ▶️ processPostContent START pid=${pid}`);
    const replacements = new Map();
    try {
        const postData = await posts.getPostData(pid);
        if (!postData || !postData.content) {
            // console.log(`[cline-links] ⛔ pid=${pid} no postData/content, postData=${!!postData}`);
            return { replacements };
        }
        // console.log(`[cline-links] 📄 pid=${pid} content length=${postData.content.length}, uid=${postData.uid}`);

        const settings = await meta.settings.get('cline-links');
        const postOwnerUid = parseInt(postData.uid, 10);
        const aliService = new AliExpressService(settings);

        const result = await findAndReplaceLinks(postData.content, postOwnerUid, settings, aliService);
        if (!result.modified) {
            // console.log(`[cline-links] ⛔ pid=${pid} no matching URLs found, returning`);
            return { replacements };
        }
        for (const [orig, final] of result.replacements) replacements.set(orig, final);
        const currentContent = result.content;

        {
            // console.log(`[cline-links] 💾 saving pid=${pid}, new content preview:`, currentContent.substring(0, 300));
            await posts.setPostField(pid, 'content', currentContent);
            await posts.clearCachedPost(pid);

            const verifyData = await posts.getPostData(pid);
            // console.log(`[cline-links] ✅ verify after save pid=${pid}, stored content preview:`, verifyData?.content?.substring(0, 300));

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
            // console.log(`[cline-links] Broadcasted exact structure for PID ${pid}`);

        }

    } catch (err) {
        console.error('[cline-links] Error:', err);
    }
    return { replacements };
}

function normalizeUrl(url) {
    if (!url) return '';
    let cleaned = url.replace(/[).,;!]+$/, '').trim();
    if (!/^https?:\/\//i.test(cleaned)) {
        cleaned = 'https://' + cleaned;
    }
    return cleaned;
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