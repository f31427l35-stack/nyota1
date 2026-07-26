/**
 * Vercel Serverless Function
 * POST /api/paynexus-callback
 *
 * Register this exact URL (https://your-app.vercel.app/api/paynexus-callback)
 * via PayNexus's webhook registration endpoint or dashboard, subscribed to
 * at least ["payment.completed", "payment.failed"]. The webhook secret
 * generated there goes into PAYNEXUS_WEBHOOK_SECRET below.
 *
 * SECURITY: every request here MUST have its signature verified before
 * being trusted. Without this, anyone who discovers this URL could POST a
 * fake "payment.completed" event and mark an unpaid application as paid.
 * PayNexus signs the RAW request body with HMAC-SHA256, sent in the
 * X-PayNexus-Signature header — which is why body parsing is disabled
 * below (Vercel's default JSON parsing would otherwise destroy the exact
 * byte sequence the signature was computed over).
 */

import crypto from 'crypto';
import { setPaymentStatus, getReferenceByCheckoutRequestId } from '../lib/store.js';

export const config = {
    api: {
        bodyParser: false
    }
};

function readRawBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function statusFromEvent(eventName) {
    if (eventName === 'payment.completed') return 'SUCCESS';
    if (eventName === 'payment.failed') return 'FAILED';
    // payment.initiated and anything else — no status change, just logged.
    return null;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Method not allowed' });
    }

    if (!process.env.PAYNEXUS_WEBHOOK_SECRET) {
        console.error('Missing PAYNEXUS_WEBHOOK_SECRET — refusing to process an unverifiable webhook');
        return res.status(500).json({ ResultCode: 1, ResultDesc: 'Webhook secret not configured' });
    }

    const rawBody = await readRawBody(req);
    const signature = req.headers['x-paynexus-signature'];

    const expected = crypto
        .createHmac('sha256', process.env.PAYNEXUS_WEBHOOK_SECRET)
        .update(rawBody)
        .digest('hex');

    if (!signature || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
        console.warn('PayNexus webhook signature mismatch — ignoring request');
        return res.status(401).json({ ResultCode: 1, ResultDesc: 'Invalid signature' });
    }

    let payload;
    try {
        payload = JSON.parse(rawBody.toString());
    } catch (err) {
        console.error('PayNexus webhook: could not parse verified body as JSON', err);
        return res.status(400).json({ ResultCode: 1, ResultDesc: 'Malformed payload' });
    }

    console.log('PayNexus webhook received (signature verified):', JSON.stringify(payload, null, 2));

    const { event, data } = payload || {};

    if (!data || !data.reference) {
        console.warn('Webhook missing reference — event:', event);
        return res.status(200).json({ ResultCode: 0, ResultDesc: 'Received' });
    }

    // PayNexus's reference was linked back to our own reference at
    // initiate-time via linkCheckoutRequestId.
    const reference = getReferenceByCheckoutRequestId(data.reference);

    if (!reference) {
        console.warn('No stored reference for this webhook — PayNexus reference:', data.reference);
        return res.status(200).json({ ResultCode: 0, ResultDesc: 'Received' });
    }

    const status = statusFromEvent(event);

    if (status === 'SUCCESS') {
        setPaymentStatus(reference, {
            status: 'SUCCESS',
            paynexusStatus: data.status,
            providerTransactionId: data.provider_transaction_id,
            payerName: data.payer_name,
            event
        });
    } else if (status === 'FAILED') {
        setPaymentStatus(reference, {
            status: 'FAILED',
            paynexusStatus: data.status,
            failureReason: data.failure_reason,
            userMessage: data.user_message,
            event
        });
    } else {
        // payment.initiated / invoice.* / subscription.* — logged only,
        // no status change (avoids overwriting PENDING with duplicate info
        // or clobbering a later SUCCESS/FAILED if delivered out of order).
        console.log(`Webhook event "${event}" received for ${reference} — no status change applied`);
    }

    // Must respond 2xx quickly or PayNexus will retry with backoff.
    res.status(200).json({ ResultCode: 0, ResultDesc: 'Received' });
}
