'use strict';

const db = require.main.require('./src/database');
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
        resolve: true
    },
    {
        name: 'Temu Direct',
        regex: /https?:\/\/(?:\w+\.)?temu\.com\/[^\s)]+/g,
        resolve: false
    },
    {
        name: 'AliExpress Direct',
        regex: /https?:\/\/(?:\w+\.)?aliexpress\.com\/(?:item\/|ssr\/|store\/|p\/)[^\s)]+/g,
        resolve: false
    },
    {
        name: 'Amazon Direct',
        regex: /https?:\/\/(?:\w+\.)?amazon\.(?:com|co\.uk|de|it|fr|es|ca)\/(?:dp|gp\/product)\/[\w\d]+[^\s)]*/g,
        resolve: false
    }
];

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

    // חילוץ UID בצורה בטוחה לפי הפלט שסיפקת
    const uid = parseInt(
        hookData.uid || 
        (hookData.post && hookData.post.uid) || 
        (hookData.data && hookData.data.uid) || 
        (hookData.caller && hookData.caller.uid), 
        10
    );

    const isAdmin = ADMIN_UIDS.includes(uid);
    let content = hookData.post.content;
    let modified = false;

    // מציאת כל הקישורים הפוטנציאליים בפוסט
    const matchesFound = [];
    for (const rule of CLEANING_RULES) {
        const matches = content.match(rule.regex);
        if (matches) {
            matches.forEach(m => matchesFound.push({ original: m, rule }));
        }
    }

    if (matchesFound.length === 0) return hookData;

    // הסרת כפילויות של מחרוזות קישור
    const uniqueStrings = [...new Set(matchesFound.map(m => m.original))];

    if (isAdmin) {
        // מנהל מעלה/עורך פוסט: מוסיפים את הקישורים לרשימה הלבנה ולא נוגעים בתוכן
        const linksToWhitelist = uniqueStrings.map(normalizeUrl);
        await db.setAdd(WHITELIST_DB_KEY, linksToWhitelist);
        return hookData;
    }

    // משתמש רגיל: מנקים קישורים אלא אם הם ברשימה הלבנה
    for (const originalUrl of uniqueStrings) {
        const normalized = normalizeUrl(originalUrl);

        // בדיקה האם הקישור כבר אושר בעבר ע"י אדמין
        const isWhitelisted = await db.isSetMember(WHITELIST_DB_KEY, normalized);
        if (isWhitelisted) continue;

        const ruleMatch = matchesFound.find(m => m.original === originalUrl);
        let finalUrl = originalUrl;

        // אם זה קישור מקוצר - פותחים אותו
        if (ruleMatch.rule.resolve) {
            finalUrl = await resolveShortLink(normalized);
            // אם הקישור שנפתח כבר ברשימה הלבנה - דלג
            const finalNormalized = normalizeUrl(finalUrl);
            if (await db.isSetMember(WHITELIST_DB_KEY, finalNormalized)) continue;
        }

        const cleanUrl = stripAffiliateParameters(finalUrl);

        if (cleanUrl !== normalized) {
            const escapedUrl = originalUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            content = content.replace(new RegExp(escapedUrl, 'g'), cleanUrl);
            modified = true;
        }
    }

    if (modified) {
        hookData.post.content = content;
    }

    return hookData;
};

module.exports = plugin;