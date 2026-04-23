'use strict';

const axios = require('axios');
const crypto = require('crypto');

class AliExpressService {
    constructor(config) {
        this.appKey = config.appKey;
        this.appSecret = config.appSecret;
        this.trackingId = config.trackingId;
        this.endpoint = 'https://api-sg.aliexpress.com/sync';
    }

    generateSignature(params) {
        const sortedKeys = Object.keys(params).sort();
        let basestring = this.appSecret;
        for (const key of sortedKeys) {
            basestring += key + params[key];
        }
        basestring += this.appSecret;
        return crypto.createHash('md5').update(basestring, 'utf8').digest('hex').toUpperCase();
    }

    async convertToAffiliate(sourceUrl, subId) {
        if (!this.appKey || !this.appSecret) return null;

        const timestamp = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
        const params = {
            method: 'aliexpress.affiliate.link.generate',
            app_key: this.appKey,
            format: 'json',
            v: '2.0',
            sign_method: 'md5',
            timestamp: timestamp,
            tracking_id: this.trackingId || 'api',
            promotion_link_type: '0',
            source_values: sourceUrl
        };

        if (subId) {
            params.sub_id = subId.toString();
        }

        params.sign = this.generateSignature(params);

        try {
            const data = new URLSearchParams();
            for (const key in params) data.append(key, params[key]);

            const response = await axios.post(this.endpoint, data.toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
                timeout: 5000
            });

            const result = response.data.aliexpress_affiliate_link_generate_response?.resp_result?.result;
            return result?.promotion_links?.promotion_link[0]?.promotion_link || null;
        } catch (error) {
            console.error('[AliExpress API Error]', error.message);
            return null;
        }
    }
}

module.exports = AliExpressService;