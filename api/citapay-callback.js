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
 * Requires BLUEPAY_API_SECRET — a separate credential from
 * BLUEPAY_BASIC_AUTH used for outgoing calls in initiate-payment.js. Per
 * the docs' Authentication section: "Webhook HMAC always uses the API
 * secret, not Basic credentials" — Bearer and Basic are two different
 * credentials on the same API Keys page, and HMAC always uses the former
 * regardless of which one you use for outgoing requests.
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

    if (!process.env.BLUEPAY_API_SECRET) {
        console.error('Missing BLUEPAY_API_SECRET — refusing to process an unverifiable webhook');
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
        .createHmac('sha256', process.env.BLUEPAY_API_SECRET)
        .update(rawBody)
        .digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(match[1]))) {
        console.warn('BluePay webhook signature mismatch — ignoring request. BLUEPAY_API_SECRET must match the "API secret" field on the API Keys page, not the Basic-auth username/password.', {
            expected,
            received: match[1]
        });
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

    // checkout_request_id is the reliable match — it's linked to our
    // reference at initiate-time regardless of any prefix BluePay adds.
    // account_reference comes back WITH the merchant prefix now (see
    // BLUEPAY_REFERENCE_PREFIX in initiate-payment.js), so it only works
    // as a fallback once that prefix is stripped back off — and won't
    // help at all for payments that didn't originate from
    // initiate-payment.js (e.g. pay links), which is what this fallback
    // is really for.
    let reference = data.checkout_request_id
        ? getReferenceByCheckoutRequestId(data.checkout_request_id)
        : null;

    if (!reference && data.account_reference) {
        const prefix = process.env.BLUEPAY_REFERENCE_PREFIX || '';
        reference = prefix && data.account_reference.startsWith(prefix)
            ? data.account_reference.slice(prefix.length)
            : data.account_reference;
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
