/**
 * Vercel Serverless Function
 * POST /api/bluepay-callback
 *
 * Set this URL (https://your-app.vercel.app/api/bluepay-callback) as your
 * Callback URL in the BluePay dashboard under Account settings (or pass
 * callback_url per-STK if you need per-request overrides).
 *
 * SECURITY: every request here MUST have its signature verified before
 * being trusted. Without this, anyone who discovers this URL could POST a
 * fake "mpesa.payment.received" event and mark an unpaid application as
 * paid. BluePay signs the RAW request body with HMAC-SHA256 using your
 * API secret, sent as "v1=<hex>" in the X-BluePay-Signature header —
 * which is why body parsing is disabled below (Vercel's default JSON
 * parsing would otherwise destroy the exact byte sequence the signature
 * was computed over).
 *
 * Reuses BLUEPAY_API_KEY (same secret used as the Bearer token in
 * initiate-payment.js) — BluePay's docs confirm the webhook HMAC always
 * uses the API secret, never the Basic-auth credential.
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
    if (eventName === 'mpesa.payment.received') return 'SUCCESS';
    if (eventName === 'mpesa.payment.failed') return 'FAILED';
    // mpesa.wallet_topup.received / mpesa.b2c.* / mpesa.b2c_wallet_topup.received
    // aren't relevant to a loan-application STK payment — logged only.
    return null;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ received: false, message: 'Method not allowed' });
    }

    if (!process.env.BLUEPAY_API_KEY) {
        console.error('Missing BLUEPAY_API_KEY — refusing to process an unverifiable webhook');
        return res.status(500).json({ received: false, message: 'Webhook secret not configured' });
    }

    const rawBody = await readRawBody(req);
    const signatureHeader = req.headers['x-bluepay-signature'] || '';

    // BluePay's documented format: "v1=" + hex(HMAC-SHA256(raw body, secret))
    const match = /^v1=([a-f0-9]{64})$/.exec(signatureHeader);

    if (!match) {
        console.warn('BluePay webhook: missing or malformed X-BluePay-Signature header');
        return res.status(400).json({ received: false, message: 'Missing or malformed signature' });
    }

    const expected = crypto
        .createHmac('sha256', process.env.BLUEPAY_API_KEY)
        .update(rawBody)
        .digest('hex');

    // A signature mismatch on your endpoint is the #1 cause of a 401 here
    // per BluePay's docs — almost always means BLUEPAY_API_KEY doesn't
    // match the secret shown on the dashboard's API Keys page.
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(match[1]))) {
        console.warn('BluePay webhook signature mismatch — ignoring request');
        return res.status(401).json({ received: false, message: 'Invalid signature' });
    }

    let payload;
    try {
        payload = JSON.parse(rawBody.toString());
    } catch (err) {
        console.error('BluePay webhook: could not parse verified body as JSON', err);
        return res.status(400).json({ received: false, message: 'Malformed payload' });
    }

    console.log('BluePay webhook received (signature verified):', JSON.stringify(payload, null, 2));

    const { event, data } = payload || {};

    if (!data) {
        console.warn('Webhook missing data object — event:', event);
        return res.status(200).json({ received: true });
    }

    // account_reference is echoed back exactly as we sent it in
    // initiate-payment.js's STK request, so it doubles as our own
    // reference directly — no lookup table needed for the common case.
    // Fall back to the checkout_request_id -> reference map (populated at
    // initiate-time) only if account_reference is missing or unrecognized,
    // e.g. for pay-link-initiated payments that didn't go through our
    // initiate-payment.js at all.
    let reference = data.account_reference;
    if (!reference && data.checkout_request_id) {
        reference = getReferenceByCheckoutRequestId(data.checkout_request_id);
    }

    if (!reference) {
        console.warn('No reference found on webhook — checkout_request_id:', data.checkout_request_id);
        return res.status(200).json({ received: true });
    }

    const status = statusFromEvent(event);

    if (status === 'SUCCESS') {
        setPaymentStatus(reference, {
            status: 'SUCCESS',
            mpesaReceiptNumber: data.mpesa_receipt_number,
            checkoutRequestId: data.checkout_request_id,
            paymentId: data.payment_id,
            event
        });
    } else if (status === 'FAILED') {
        setPaymentStatus(reference, {
            status: 'FAILED',
            bluepayStatus: data.status,
            checkoutRequestId: data.checkout_request_id,
            // BluePay's webhook payload doesn't document a customer-facing
            // failure-reason field (unlike PayNexus's data.user_message),
            // so payment-status.js falls back to a generic message here.
            // If BluePay's STK error codes page documents a message field
            // in the failed-event payload, swap this for that value.
            userMessage: 'Payment could not be completed. Please try again.',
            event
        });
    } else {
        // Logged only — avoids overwriting PENDING with unrelated event
        // info, or clobbering a later SUCCESS/FAILED if delivered out of order.
        console.log(`Webhook event "${event}" received for ${reference} — no status change applied`);
    }

    // Must respond 2xx quickly — BluePay does not automatically retry
    // failed webhook deliveries (unlike PayNexus's backoff retries), so
    // payment-status.js polling is your backup if this ever fails.
    return res.status(200).json({ received: true });
}
