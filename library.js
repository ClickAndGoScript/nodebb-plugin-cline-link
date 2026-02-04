'use strict';

const plugin = {};

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
    'productIds', 'bundle_id', 'gatewayAdapt', 'g_site', 'g_region', 'g_lg', 'g_ccy', 'subj'
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
        // מעודכן לזהות גם item, גם ssr וגם דפי חנות/מבצעים
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
 * מנקה פרמטרים מה-URL בצורה חכמה
 */
function stripAffiliateParameters(url) {
    try {
        const cleanUrlStr = url.replace(/[).,;!]+$/, '');
        const urlObj = new URL(cleanUrlStr);
        const params = urlObj.searchParams;
        const keys = Array.from(params.keys());

        keys.forEach(key => {
            // 1. הסרה אם הפרמטר ברשימה השחורה (כמו spm)
            if (BLACKLISTED_PARAMS.includes(key)) {
                params.delete(key);
            }
            // 2. הסרה אם זה פרמטר מעקב של טמו (_x_)
            else if (key.startsWith('_x_')) {
                params.delete(key);
            }
            // 3. ניקוי אגרסיבי לדפי מוצר/נחיתה: מה שלא בוויטליסט - נמחק
            else if (
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

    let content = hookData.post.content;
    let modified = false;

    for (const rule of CLEANING_RULES) {
        const matches = content.match(rule.regex);
        if (!matches) continue;

        const uniqueMatches = [...new Set(matches)].sort((a, b) => b.length - a.length);

        for (const matchedUrl of uniqueMatches) {
            let actualUrl = matchedUrl;
            if (actualUrl.endsWith(')')) actualUrl = actualUrl.slice(0, -1);

            let finalUrl = actualUrl;
            if (rule.resolve) {
                finalUrl = await resolveShortLink(actualUrl);
            }

            const cleanUrl = stripAffiliateParameters(finalUrl);

            if (cleanUrl !== actualUrl) {
                const escapedUrl = actualUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                content = content.replace(new RegExp(escapedUrl, 'g'), cleanUrl);
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