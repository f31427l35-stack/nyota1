/**
 * Vercel Serverless Function
 * GET /api/payment-status?transaction_request_id=XXXXXXXX
 *
 * Polled by the frontend every few seconds after initiating a payment.
 *
 * UNLIKE the other providers integrated today, this calls Paywave
 * Express's own POST /v1/tstatus endpoint directly on every poll, rather
 * than reading from a local store that a webhook previously updated.
 * Two reasons this is the safer design here specifically:
 *
 *   1. Paywave Express's docs don't describe any webhook signature
 *      verification scheme — no HMAC, no secret. An unverified webhook
 *      can't be trusted to mark a payment SUCCESS on its own (anyone who
 *      found the URL could fake one). Querying the provider directly,
 *      authenticated with our own API key, has no such hole.
 *   2. It sidesteps the in-memory-store cross-function reliability
 *      problem entirely for the thing that matters most (final
 *      success/failure) — no dependency on Vercel happening to route
 *      requests to a warm container that shares memory with another
 *      function.
 */

const BASE_URL = 'https://paywavexpress.co.ke';

function mapStatus(transactionStatus) {
    switch (String(transactionStatus || '').toLowerCase()) {
        case 'completed':
            return 'SUCCESS';
        case 'failed':
        case 'cancelled':
            return 'FAILED';
        case 'pending':
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

    if (!process.env.PAYWAVEXPRESS_API_KEY || !process.env.PAYWAVEXPRESS_EMAIL) {
        console.error('Missing PAYWAVEXPRESS_API_KEY or PAYWAVEXPRESS_EMAIL environment variable');
        return res.status(500).json({ status: 'ERROR', message: 'Payment provider not configured' });
    }

    try {
        const response = await fetch(`${BASE_URL}/v1/tstatus`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                api_key: process.env.PAYWAVEXPRESS_API_KEY,
                email: process.env.PAYWAVEXPRESS_EMAIL,
                transaction_request_id
            })
        });

        const raw = await response.text();
        let body;
        try {
            body = JSON.parse(raw);
        } catch {
            console.error('Paywave Express tstatus returned non-JSON response:', raw);
            // Report PENDING rather than FAILED on a parse hiccup — a
            // transient/malformed response here shouldn't be mistaken for
            // an actual payment failure. The frontend will just poll again.
            return res.status(200).json({ status: 'PENDING' });
        }

        if (!response.ok) {
            console.error('Paywave Express tstatus call failed:', body);
            return res.status(200).json({ status: 'PENDING' });
        }

        return res.status(200).json({
            status: mapStatus(body.TransactionStatus),
            receipt: body.TransactionReceipt,
            amount: body.TransactionAmount
        });

    } catch (err) {
        console.error('Paywave Express tstatus request error:', err);
        // Network hiccup talking to the provider — report PENDING so the
        // frontend keeps polling rather than giving up on a transient blip.
        return res.status(200).json({ status: 'PENDING' });
    }
}
