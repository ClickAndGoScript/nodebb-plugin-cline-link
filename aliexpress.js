'use strict';

const axios = require('axios');
const crypto = require('crypto');

class AliExpressService {
    constructor(config) {
        this.appKey = (config.appKey || '').trim();
        this.appSecret = (config.appSecret || '').trim();
        this.trackingId = (config.trackingId || '').trim();
        this.endpoint = 'https://api-sg.aliexpress.com/sync';
        // console.log(`[AliExpress] init appKey="${this.appKey}" (len=${this.appKey.length}), secretLen=${this.appSecret.length}, trackingId="${this.trackingId}"`);
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

    async convertToAffiliate(sourceUrl, subId, trackingIdOverride) {
        if (!this.appKey || !this.appSecret) return null;

        const timestamp = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
        const params = {
            method: 'aliexpress.affiliate.link.generate',
            app_key: this.appKey,
            format: 'json',
            v: '2.0',
            sign_method: 'md5',
            timestamp: timestamp,
            tracking_id: (trackingIdOverride || '').trim() || this.trackingId || 'api',
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

            // console.log('[AliExpress] 📤 request params:', JSON.stringify({ ...params, sign: params.sign.substring(0, 8) + '...' }));

            const response = await axios.post(this.endpoint, data.toString(), {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
                timeout: 5000
            });

            // console.log('[AliExpress] 📥 full response:', JSON.stringify(response.data));

            const respBody = response.data.aliexpress_affiliate_link_generate_response;
            if (respBody?.resp_result?.resp_code && respBody.resp_result.resp_code !== 200) {
                console.error('[AliExpress] ⚠️ resp_code=', respBody.resp_result.resp_code, 'msg=', respBody.resp_result.resp_msg);
            }
            if (response.data.error_response) {
                console.error('[AliExpress] ❌ error_response:', JSON.stringify(response.data.error_response));
            }

            const result = respBody?.resp_result?.result;
            const link = result?.promotion_links?.promotion_link?.[0]?.promotion_link || null;
            if (!link) {
                console.warn('[AliExpress] ⛔ no promotion_link in result. result=', JSON.stringify(result));
            }
            return link;
        } catch (error) {
            console.error('[AliExpress API Error]', error.message);
            if (error.response) {
                console.error('[AliExpress API Error] response status=', error.response.status, 'data=', JSON.stringify(error.response.data));
            }
            return null;
        }
    }
}

module.exports = AliExpressService;