'use strict';

const plugin = {};

// רשימת פרמטרים שמהווים מזהי שותפים או מעקב שיש להסיר
const BLACKLISTED_PARAMS = [
    '_x_cid', '_x_ads_channel', '_x_campaign', '_x_vst_scene', 
    'refer_share_id', 'refer_share_uid', 'invite_code', 
    'aff_id', 'aff_platform', 'aff_trace_key', 'tag', 'ref',
    'linkCode', 'ref_', 'creative', 'camp', 'collection_id'
];

/**
 * רג'קס משופר לאיתור כתובות URL:
 * הוא מחפש תווים שאינם רווח, אבל עוצר לפני סוגריים סוגרים, נקודה או פסיק בסוף הכתובת
 */
const URL_REGEX_SUFFIX = /[^\s)]+(?=[^.,;!?:>\s)]|(?:\s|$))/g;

const CLEANING_RULES = [
    {
        name: 'Short Links',
        // שימוש ב- [^\s)]+ במקום \S+ כדי לא לכלול סוגר של Markdown
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
        regex: /https?:\/\/(?:\w+\.)?aliexpress\.com\/item\/\d+\.html[^\s)]*/g,
        resolve: false
    },
    {
        name: 'Amazon Direct',
        regex: /https?:\/\/(?:\w+\.)?amazon\.(?:com|co\.uk|de|it|fr|es|ca)\/(?:dp|gp\/product)\/[\w\d]+[^\s)]*/g,
        resolve: false
    }
];

/**
 * מנקה פרמטרים ספציפיים מתוך ה-URL
 */
function stripAffiliateParameters(url) {
    try {
        // ניקוי תווים מיותרים שעלולים להידבק לסוף ה-URL לפני הניתוח
        const cleanUrlStr = url.replace(/[).,;!]+$/, '');
        const urlObj = new URL(cleanUrlStr);
        const params = urlObj.searchParams;

        BLACKLISTED_PARAMS.forEach(param => params.delete(param));
        
        const keys = Array.from(params.keys());
        keys.forEach(key => {
            if (key.startsWith('_x_')) {
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

    let content = hookData.post.content;
    let modified = false;

    for (const rule of CLEANING_RULES) {
        const matches = content.match(rule.regex);
        if (!matches) continue;

        // הסרת כפילויות ומיון מהארוך לקצר כדי למנוע החלפות חלקיות
        const uniqueMatches = [...new Set(matches)].sort((a, b) => b.length - a.length);

        for (const matchedUrl of uniqueMatches) {
            // טיפול במקרה שהרג'קס תפס סוגר בסוף (לביטחון נוסף)
            let actualUrl = matchedUrl;
            if (actualUrl.endsWith(')')) {
                actualUrl = actualUrl.slice(0, -1);
            }

            let finalUrl = actualUrl;
            if (rule.resolve) {
                finalUrl = await resolveShortLink(actualUrl);
            }

            const cleanUrl = stripAffiliateParameters(finalUrl);

            if (cleanUrl !== actualUrl) {
                // שימוש ב-replace ספציפי כדי לא לפגוע בטקסט מסביב
                content = content.split(actualUrl).join(cleanUrl);
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