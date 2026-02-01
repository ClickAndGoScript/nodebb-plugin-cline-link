'use strict';

const plugin = {};

/**
 * פונקציה שמקבלת קישור מקוצר ומחזירה את הקישור הסופי והנקי
 */
async function resolveAndCleanAliExpress(shortUrl) {
    try {
        // מבצעים בקשה כדי לקבל את ה-URL הסופי אחרי הפניות
        // משתמשים ב-method: 'GET' כי לעיתים HEAD לא מפעיל את כל שרשרת ההפניות באליאקספרס
        const response = await fetch(shortUrl, {
            method: 'GET',
            redirect: 'follow',
        });

        let finalUrl = response.url;

        // ניקוי הפרמטרים מהקישור
        // אליאקספרס בד"כ צריכים רק את הנתיב עד ה-.html
        const urlObj = new URL(finalUrl);
        
        // הסרת כל ה-Query string (aff_id, sk, וכו')
        urlObj.search = '';
        
        return urlObj.toString();
    } catch (err) {
        console.error('[cline-links] Error resolving link:', shortUrl, err.message);
        return shortUrl; // במקרה של שגיאה, מחזירים את המקור כדי לא להרוס את הפוסט
    }
}

plugin.cleanLinks = async function (hookData) {
    if (!hookData || !hookData.post || !hookData.post.content) {
        return hookData;
    }

    let content = hookData.post.content;
    
    // רג'קס לזיהוי קישורי אליאקספרס מקוצרים
    const aliRegex = /https?:\/\/s\.click\.aliexpress\.com\/e\/[A-Za-z0-9_]+/g;
    const matches = content.match(aliRegex);

    if (matches && matches.length > 0) {
        // מסירים כפילויות כדי לא לעבוד פעמיים על אותו קישור
        const uniqueMatches = [...new Set(matches)];

        for (const shortUrl of uniqueMatches) {
            const cleanUrl = await resolveAndCleanAliExpress(shortUrl);
            
            // החלפת הקישור המקוצר בקישור הנקי בתוך התוכן
            // אנחנו משתמשים ב-split/join כדי להחליף את כל המופעים של הקישור הספציפי הזה
            content = content.split(shortUrl).join(cleanUrl);
        }

        hookData.post.content = content;
    }

    return hookData;
};

module.exports = plugin;