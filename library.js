'use strict';

const db = require.main.require('./src/database');
const meta = require.main.require('./src/meta');
const posts = require.main.require('./src/posts');
const topics = require.main.require('./src/topics');
const users = require.main.require('./src/user');
const websockets = require.main.require('./src/socket.io');
const postCache = require.main.require('./src/posts/cache');
const AliExpressService = require('./aliexpress');

const plugin = {};

const ADMIN_UIDS = [1, 2];
const WHITELIST_DB_KEY = 'plugin:cline-links:whitelist';

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
    const { router, middleware } = params;
    router.get('/admin/plugins/cline-links', middleware.admin.buildHeader, plugin.renderAdmin);
    router.get('/api/admin/plugins/cline-links', plugin.renderAdmin);
};

plugin.renderAdmin = function (req, res) {
    res.render('admin/plugins/cline-links', { title: 'Cline Links & Affiliate' });
};

plugin.addAdminNavigation = async function (header) {
    header.plugins.push({ route: '/plugins/cline-links', icon: 'fa-shopping-cart', name: 'Cline Links' });
    return header;
};

// Hooks
plugin.handlePostSave = (data) => setImmediate(() => processPostContent(data.post));
plugin.handlePostEdit = (data) => setImmediate(() => processPostContent(data.post));

async function processPostContent(postData) {
    if (!postData || !postData.pid) return;

    try {
        const pid = postData.pid;
        // שליפה מחדש כדי לוודא שיש לנו את התוכן העדכני ביותר
        const post = await posts.getPostFields(pid, ['content', 'uid', 'tid']);
        if (!post || !post.content) return;

        const settings = await meta.settings.get('cline-links');
        const enabled = settings.enabled === 'on';
        const postOwnerUid = parseInt(post.uid, 10);
        const isAdmin = ADMIN_UIDS.includes(postOwnerUid);

        let currentContent = post.content;
        let modified = false;

        // 1. מציאת קישורים
        let matches = [];
        for (const rule of CLEANING_RULES) {
            const found = currentContent.match(rule.regex);
            if (found) {
                found.forEach(url => matches.push({ url, rule }));
            }
        }

        if (matches.length === 0) return;

        // הסרת כפילויות
        const uniqueLinks = [...new Set(matches.map(m => m.url))];
        const aliService = new AliExpressService(settings);

        console.log(`[cline-links] Processing post ${pid}. Found ${uniqueLinks.length} links.`);

        // 2. עיבוד קישורים
        for (const originalUrl of uniqueLinks) {
            const normalized = normalizeUrl(originalUrl);
            const match = matches.find(m => m.url === originalUrl);

            // אם אדמין פרסם - אנחנו מוסיפים לרשימה לבנה וממשיכים (לא עוצרים!)
            if (isAdmin) {
                await db.setAdd(WHITELIST_DB_KEY, normalized);
            } else {
                // אם משתמש רגיל פרסם קישור שקיים ברשימה הלבנה - דלג עליו
                const isWhitelisted = await db.isSetMember(WHITELIST_DB_KEY, normalized);
                if (isWhitelisted) continue;
            }

            let workUrl = normalized;

            // שלב א: Resolve לקישורים מקוצרים
            if (match.rule.resolve) {
                workUrl = await resolveShortLink(workUrl);
            }

            // שלב ב: ניקוי פרמטרים
            let finalUrl = stripAffiliateParameters(workUrl);

            // שלב ג: המרה לאליאקספרס
            if (enabled && (match.rule.isAliExpress || finalUrl.includes('aliexpress.com'))) {
                const subId = postOwnerUid > 0 ? `u${postOwnerUid}` : 'guest';
                const affiliateUrl = await aliService.convertToAffiliate(finalUrl, subId);
                if (affiliateUrl) finalUrl = affiliateUrl;
            }

            // החלפה בטקסט
            if (finalUrl !== originalUrl) {
                const escaped = originalUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                currentContent = currentContent.replace(new RegExp(escaped, 'g'), finalUrl);
                modified = true;
            }
        }

        if (modified) {
            await posts.setPostField(pid, 'content', currentContent);
            postCache.del(pid);

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