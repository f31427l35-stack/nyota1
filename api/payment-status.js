/**
 * Vercel Serverless Function
 * GET /api/payment-status?transaction_request_id=XXXXXXXX
 *
 * Polled by the frontend every few seconds after initiating a payment.
 *
 * Same architecture as the Sendit/Paywave Express integrations this
 * replaced: this calls UpesiPay's own GET /api/v2/transaction-status
 * endpoint directly on every poll, rather than relying on a webhook having
 * already updated a local store. Two reasons this is still the safer
 * design here:
 *
 *   1. UpesiPay's real STK callback posts straight to our own
 *      callback_url, and it's unsigned — no documented HMAC/signature
 *      verification. Same "anyone who finds the URL could fake it"
 *      problem the Sendit developer-webhook path had. Querying UpesiPay
 *      directly, authenticated with our own token, has no such hole.
 *   2. It sidesteps the in-memory-store cross-function reliability problem
 *      entirely for the thing that matters most (final success/failure).
 */

const UPESIPAY_BASE_URL = 'https://upesipay.com/api/v2';

function getBasicAuthHeader() {
    // Same reasoning as initiate-payment.js: build the Basic Auth header
    // ourselves as base64("username:password") rather than trusting a
    // pre-built token string from the UpesiPay dashboard, which caused
    // 401 "Invalid authentication token format" errors.
    const username = process.env.UPESIPAY_API_USERNAME;
    const password = process.env.UPESIPAY_API_PASSWORD;
    if (!username || !password) return null;
    return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function mapStatus(upesiStatus) {
    // UpesiPay's callback/status vocabulary is 'success' | 'failed' |
    // 'cancelled' | 'timeout', with an in-flight state presumably reported
    // as something like 'pending' or 'processing' before completion.
    // Different vocabulary from Sendit's lowercase three-state shape, but
    // the mapping principle is the same: anything not clearly terminal
    // stays PENDING so the frontend keeps polling.
    switch (String(upesiStatus || '').toLowerCase()) {
        case 'success':
            return 'SUCCESS';
        case 'failed':
        case 'cancelled':
        case 'timeout':
            return 'FAILED';
        case 'pending':
        case 'processing':
        default:
            return 'PENDING';
    }
}

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ status: 'ERROR', message: 'Method not allowed' });
    }

    const { transaction_request_id } = req.query;

    if (!transaction_request_id) {
        return res.status(400).json({ status: 'ERROR', message: 'Missing transaction_request_id' });
    }

    const authHeader = getBasicAuthHeader();
    if (!authHeader) {
        console.error('Missing UPESIPAY_API_USERNAME or UPESIPAY_API_PASSWORD environment variable');
        return res.status(500).json({ status: 'ERROR', message: 'Payment provider not configured' });
    }

    try {
        const response = await fetch(
            `${UPESIPAY_BASE_URL}/transaction-status?reference=${encodeURIComponent(transaction_request_id)}`,
            {
                method: 'GET',
                headers: { 'Authorization': authHeader }
            }
        );

        const raw = await response.text();
        console.log('UpesiPay status raw response:', raw);
        let body;
        try {
            body = JSON.parse(raw);
        } catch {
            console.error('UpesiPay status returned non-JSON response:', raw);
            // Report PENDING rather than FAILED on a parse hiccup — a
            // transient/malformed response here shouldn't be mistaken for
            // an actual payment failure. The frontend will just poll again.
            return res.status(200).json({ status: 'PENDING' });
        }

        if (!response.ok) {
            // Includes the 404 "transaction not found" case, which can happen
            // briefly right after initiate-payment if there's any replication
            // lag on UpesiPay's side — treat the same as a transient PENDING
            // rather than surfacing it as a failure.
            console.error('UpesiPay status call failed:', body);
            return res.status(200).json({ status: 'PENDING' });
        }

        const data = body.data || {};

        return res.status(200).json({
            status: mapStatus(data.status),
            receipt: data.id,
            amount: data.amount
        });

    } catch (err) {
        console.error('UpesiPay status request error:', err);
        // Network hiccup talking to the provider — report PENDING so the
        // frontend keeps polling rather than giving up on a transient blip.
        return res.status(200).json({ status: 'PENDING' });
    }
}
