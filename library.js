'use strict';

const plugin = {};

// רשימת פרמטרים שמהווים מזהי שותפים או מעקב שיש להסיר
const BLACKLISTED_PARAMS = [
    '_x_cid', '_x_ads_channel', '_x_campaign', '_x_vst_scene', 
    'refer_share_id', 'refer_share_uid', 'invite_code', 
    'aff_id', 'aff_platform', 'aff_trace_key', 'tag', 'ref',
    'linkCode', 'ref_', 'creative', 'camp', 'collection_id'
];

// הגדרת חוקי הניקוי
const CLEANING_RULES = [
    {
        name: 'Short Links', // קישורים מקוצרים שחייבים פתיחה
        regex: /https?:\/\/(?:s\.click\.aliexpress\.com|a\.aliexpress\.com|temu\.to|share\.temu\.com|amzn\.to|ebay\.to)\/\S+/g,
        resolve: true
    },
    {
        name: 'Temu Direct',
        regex: /https?:\/\/(?:\w+\.)?temu\.com\/\S+/g,
        resolve: false
    },
    {
        name: 'AliExpress Direct',
        regex: /https?:\/\/(?:\w+\.)?aliexpress\.com\/item\/\d+\.html\S*/g,
        resolve: false
    },
    {
        name: 'Amazon Direct',
        regex: /https?:\/\/(?:\w+\.)?amazon\.(?:com|co\.uk|de|it|fr|es|ca)\/(?:dp|gp\/product)\/[\w\d]+\S*/g,
        resolve: false
    }
];

/**
 * מנקה פרמטרים ספציפיים מתוך ה-URL
 */
function stripAffiliateParameters(url) {
    try {
        const urlObj = new URL(url);
        const params = urlObj.searchParams;

        // הסרת פרמטרים מרשימת הבלוק
        BLACKLISTED_PARAMS.forEach(param => params.delete(param));
        
        // הסרת כל פרמטר שמתחיל ב- _x_ (נפוץ ב-Temu)
        const keys = Array.from(params.keys());
        keys.forEach(key => {
            if (key.startsWith('_x_')) {
                params.delete(key);
            }
        });

        // אם זה קישור מוצר רגיל (לא דף נחיתה מיוחד), אפשר לנקות הכל
        // אבל בשביל דפי kuiper וכו', נשאיר את מה שנותר
        if (urlObj.pathname.includes('/item/') || urlObj.pathname.includes('/dp/')) {
            // במוצרים רגילים אפשר להחמיר יותר אם רוצים
        }

        return urlObj.toString();
    } catch (e) {
        return url;
    }
}

/**
 * פונקציה שמנסה לגלות את הכתובת הסופית של קישור מקוצר
 */
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
        console.error(`[cline-links] Failed to resolve: ${url}`, err.message);
        return url;
    }
}

plugin.cleanLinks = async function (hookData) {
    if (!hookData || !hookData.post || !hookData.post.content) {
        return hookData;
    }

    let content = hookData.post.content;
    let modified = false;

    for (const rule of CLEANING_RULES) {
        const matches = content.match(rule.regex);
        if (!matches) continue;

        const uniqueMatches = [...new Set(matches)];

        for (const matchedUrl of uniqueMatches) {
            let finalUrl = matchedUrl;

            if (rule.resolve) {
                finalUrl = await resolveShortLink(matchedUrl);
            }

            // ניקוי סלקטיבי של פרמטרים
            const cleanUrl = stripAffiliateParameters(finalUrl);

            if (cleanUrl !== matchedUrl) {
                // החלפה בטוחה של הקישור בטקסט
                content = content.split(matchedUrl).join(cleanUrl);
                modified = true;
            }
        }
    }

    if (modified) {
        hookData.post.content = content;
    }

    return hookData;
};

module.exports = plugin;