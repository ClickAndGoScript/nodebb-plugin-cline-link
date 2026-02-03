'use strict';

const plugin = {};

// הגדרת חוקי הניקוי לכל אתר
const CLEANING_RULES = [
    {
        name: 'AliExpress Short',
        regex: /https?:\/\/(?:s\.click|a)\.aliexpress\.com\/\S+/g,
        resolve: true // קישור מקוצר דורש פתיחה בשרת
    },
    {
        name: 'AliExpress Direct',
        regex: /https?:\/\/(?:\w+\.)?aliexpress\.com\/item\/\d+\.html\S*/g,
        resolve: false // קישור ישיר - רק לנקות פרמטרים
    },
    {
        name: 'Temu Short',
        regex: /https?:\/\/(?:temu\.to|share\.temu\.com)\/\S+/g,
        resolve: true
    },
    {
        name: 'Amazon Short',
        regex: /https?:\/\/amzn\.to\/\S+/g,
        resolve: true
    },
    {
        name: 'Amazon Direct',
        regex: /https?:\/\/(?:\w+\.)?amazon\.(?:com|co\.uk|de|it|fr|es|ca)\/(?:dp|gp\/product)\/[\w\d]+\S*/g,
        resolve: false
    },
    {
        name: 'eBay Short',
        regex: /https?:\/\/ebay\.to\/\S+/g,
        resolve: true
    }
];

/**
 * פונקציה שמנקה את ה-URL מכל ה-Query Parameters
 */
function stripParameters(url) {
    try {
        const urlObj = new URL(url);
        // עבור אמזון, לפעמים הקישור הנקי דורש את ה-Path עד ה-ASIN
        // ברוב האתרים (עלי, טמו) איפוס ה-search וה-hash מספיק
        urlObj.search = '';
        urlObj.hash = '';
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
            signal: AbortSignal.timeout(5000) // הגבלת זמן ל-5 שניות כדי לא לתקוע את השרת
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

            // 1. אם החוק דורש פתיחה (קישור מקוצר)
            if (rule.resolve) {
                finalUrl = await resolveShortLink(matchedUrl);
            }

            // 2. ניקוי פרמטרים (תמיד מנקים בסוף כדי להיות בטוחים)
            const cleanUrl = stripParameters(finalUrl);

            // 3. החלפה בתוכן (רק אם הקישור באמת השתנה)
            if (cleanUrl !== matchedUrl) {
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