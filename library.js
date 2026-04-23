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
};

plugin.renderAdmin = function (req, res) {
    res.render('admin/plugins/cline-links', { title: 'Cline Links & Affiliate' });
};

plugin.addAdminNavigation = async function (header) {
    header.plugins.push({ route: '/plugins/cline-links', icon: 'fa-shopping-cart', name: 'Cline Links' });
    return header;
};

// Hooks
plugin.handlePostSave = (data) => {
    console.log('[cline-links] 🔔 handlePostSave fired, pid=', data?.post?.pid, 'hasContent=', !!data?.post?.content);
    if (data?.post?.pid) setImmediate(() => processPostContent(data.post.pid));
};
plugin.handlePostEdit = (data) => {
    console.log('[cline-links] 🔔 handlePostEdit fired, pid=', data?.post?.pid, 'hasContent=', !!data?.post?.content);
    if (data?.post?.pid) setImmediate(() => processPostContent(data.post.pid));
};

async function processPostContent(pid) {
    console.log(`[cline-links] ▶️ processPostContent START pid=${pid}`);
    try {
        const postData = await posts.getPostData(pid);
        if (!postData || !postData.content) {
            console.log(`[cline-links] ⛔ pid=${pid} no postData/content, postData=${!!postData}`);
            return;
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
            return;
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