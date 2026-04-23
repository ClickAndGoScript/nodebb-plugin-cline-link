'use strict';

const db = require.main.require('./src/database');
const meta = require.main.require('./src/meta');
const AliExpressService = require('./aliexpress');
const plugin = {};

const ADMIN_UIDS = [1, 2];
const WHITELIST_DB_KEY = 'plugin:cline-links:whitelist';

// פרמטרים שחובה להסיר (מזהי שותפים ומעקב)
const BLACKLISTED_PARAMS = [
    'spm', 'aff_id', 'aff_platform', 'aff_trace_key', 'tag', 'ref',
    '_x_cid', '_x_ads_channel', '_x_campaign', '_x_vst_scene',
    'refer_share_id', 'refer_share_uid', 'invite_code',
    'linkCode', 'ref_', 'creative', 'camp', 'collection_id',
    'pdp_npi', 'gps-id', 'scm', 'ws_ab_test', 'pdp_ext_f', 'sourceType'
];

// פרמטרים טכניים שחובה להשאיר כדי שהדף יעבוד
const WHITELISTED_PARAMS = [
    'productIds', 'bundle_id', 'g_site', 'g_region', 'g_lg', 'g_ccy', 'subj'
];

const CLEANING_RULES = [
    {
        name: 'Short Links',
        regex: /https?:\/\/(?:s\.click\.aliexpress\.com|a\.aliexpress\.com|temu\.to|share\.temu\.com|amzn\.to|ebay\.to)\/[^\s)]+/g,
        resolve: true,
        convert: true
    },
    {
        name: 'Temu Direct',
        regex: /https?:\/\/(?:\w+\.)?temu\.com\/[^\s)]+/g,
        resolve: false,
        convert: false
    },
    {
        name: 'AliExpress Direct',
        regex: /https?:\/\/(?:\w+\.)?aliexpress\.com\/(?:item\/|ssr\/|store\/|p\/)[^\s)]+/g,
        resolve: false,
        convert: true
    },
    {
        name: 'Amazon Direct',
        regex: /https?:\/\/(?:\w+\.)?amazon\.(?:com|co\.uk|de|it|fr|es|ca)\/(?:dp|gp\/product)\/[\w\d]+[^\s)]*/g,
        resolve: false,
        convert: false
    }
];

plugin.init = async function (params) {
    const { router, middleware } = params;

    // הגדרת הנתיבים לדף הניהול
    router.get('/admin/plugins/cline-links', middleware.admin.buildHeader, plugin.renderAdmin);
    router.get('/api/admin/plugins/cline-links', plugin.renderAdmin);
};

plugin.renderAdmin = function (req, res) {
    // השם כאן חייב להתאים לנתיב של ה-tpl בתוך templates/admin/plugins/
    res.render('admin/plugins/cline-links', {
        title: 'Cline Links & Affiliate'
    });
};

plugin.addAdminNavigation = async function (header) {
    header.plugins.push({
        route: '/plugins/cline-links',
        icon: 'fa-shopping-cart',
        name: 'Cline Links'
    });
    return header;
};


/**
 * מנקה סימני פיסוק מקצה הקישור לצורך השוואה/שמירה
 */
function normalizeUrl(url) {
    if (!url) return '';
    return url.replace(/[).,;!]+$/, '').trim();
}

/**
 * מנקה פרמטרים מה-URL בצורה חכמה
 */
function stripAffiliateParameters(url) {
    try {
        const cleanUrlStr = normalizeUrl(url);
        const urlObj = new URL(cleanUrlStr);
        const params = urlObj.searchParams;
        const keys = Array.from(params.keys());

        keys.forEach(key => {
            if (BLACKLISTED_PARAMS.includes(key)) {
                params.delete(key);
            } else if (key.startsWith('_x_')) {
                params.delete(key);
            } else if (
                (urlObj.pathname.includes('/item/') ||
                    urlObj.pathname.includes('/ssr/') ||
                    urlObj.pathname.includes('/dp/')) &&
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
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36'
            },
            signal: AbortSignal.timeout(5000)
        });
        return response.url;
    } catch (err) {
        return url;
    }
}

plugin.cleanLinks = async function (hookData) {
    if (!hookData || !hookData.post || !hookData.post.content) {
        return hookData;
    }

    // 1. טעינת הגדרות וזיהוי משתמש
    const settings = await meta.settings.get('cline-links');
    const enabled = settings.enabled === 'on';
    
    const uid = parseInt(
        hookData.uid || 
        (hookData.post && hookData.post.uid) || 
        (hookData.caller && hookData.caller.uid), 
        10
    );

    const isAdmin = ADMIN_UIDS.includes(uid);
    let content = hookData.post.content;

    // 2. מציאת כל הקישורים שמתאימים לחוקים
    const matchesFound = [];
    for (const rule of CLEANING_RULES) {
        const matches = content.match(rule.regex);
        if (matches) {
            matches.forEach(m => matchesFound.push({ original: m, rule }));
        }
    }

    if (matchesFound.length === 0) return hookData;

    const uniqueStrings = [...new Set(matchesFound.map(m => m.original))];

    // 3. טיפול במנהל מערכת (הוספה לרשימה לבנה ודילוג)
    if (isAdmin) {
        const linksToWhitelist = uniqueStrings.map(normalizeUrl);
        await db.setAdd(WHITELIST_DB_KEY, linksToWhitelist);
        return hookData;
    }

    // 4. עיבוד קישורים למשתמש רגיל
    let modified = false;
    const aliService = new AliExpressService(settings);

    for (const originalUrl of uniqueStrings) {
        const normalized = normalizeUrl(originalUrl);

        // בדיקה אם הקישור אושר ע"י אדמין בעבר
        if (await db.isSetMember(WHITELIST_DB_KEY, normalized)) continue;

        const match = matchesFound.find(m => m.original === originalUrl);
        let currentUrl = normalized;

        // שלב א': פתיחת קישורים מקוצרים (Resolve)
        if (match.rule.resolve) {
            currentUrl = await resolveShortLink(currentUrl);
            // בדיקה נוספת אחרי הפתיחה אם הקישור המלא ברשימה הלבנה
            if (await db.isSetMember(WHITELIST_DB_KEY, normalizeUrl(currentUrl))) continue;
        }

        // שלב ב': ניקוי פרמטרים (Stripping)
        // מקבלים קישור נקי לחלוטין ללא מזהי מעקב
        let finalUrl = stripAffiliateParameters(currentUrl);

        // שלב ג': המרה לקישור שותפים אישי (AliExpress Affiliate)
        // השלב הזה רץ רק אם ההגדרה מופעלת וזה קישור אליאקספרס
        if (enabled && (match.rule.isAliExpress || finalUrl.includes('aliexpress.com'))) {
            const affiliateUrl = await aliService.convertToAffiliate(finalUrl);
            if (affiliateUrl) {
                finalUrl = affiliateUrl;
            }
        }

        // שלב ד': החלפה בטקסט אם חל שינוי
        if (finalUrl !== originalUrl) {
            const escapedUrl = originalUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            content = content.replace(new RegExp(escapedUrl, 'g'), finalUrl);
            modified = true;
        }
    }

    if (modified) {
        hookData.post.content = content;
    }

    return hookData;
};

module.exports = plugin;