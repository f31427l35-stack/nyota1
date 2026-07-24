/**
 * Vercel Serverless Function
 * POST /api/initiate-payment
 *
 * Called by the frontend when the user taps "Proceed to Payment".
 * Reads your BluePay API key + channel ID from Vercel Environment
 * Variables (never from the frontend) and triggers a real STK push via
 * BluePay's STK Push API.
 *
 * Set these in your Vercel project:
 *   Project -> Settings -> Environment Variables
 *     BLUEPAY_BASIC_AUTH    (the full "Basic <base64>" line — the named
 *                            credential from the BluePay dashboard's API
 *                            Keys page, used as-is in the Authorization
 *                            header, no encoding needed in code)
 *     BLUEPAY_CHANNEL_ID    (the channel UUID configured in BluePay —
 *                            use the full UUID, e.g. from the dashboard's
 *                            "Copy channel ID" button, not the short
 *                            display number shown next to it)
 *     BLUEPAY_BASE_URL      (https://bluepay.co.ke)
 *
 * NOTE ON account_reference: earlier versions of this file tried to build
 * one manually with a guessed prefix, which BluePay rejected with
 * "account_reference must start with merchant prefix". The prefix is
 * merchant/channel-specific and set when the channel was created — rather
 * than guessing it, this version simply OMITS account_reference from the
 * request entirely. Per BluePay's docs, when it's omitted they
 * auto-generate one using the channel's correct prefix, and return it in
 * the response (`body.account_reference`) — which we capture below for
 * our own records, purely informational.
 *
 * NOTE: the webhook signature in bluepay-callback.js is verified with a
 * separate BLUEPAY_API_SECRET from the same API Keys page — per BluePay's
 * docs, webhook HMAC always uses the API secret, never the Basic-auth
 * credential, so that env var is still required even though it's unused
 * here. If you later add a call to BluePay's payment_status.php as a
 * polling backup, reuse BLUEPAY_BASIC_AUTH the same way it's used below.
 */

import { setPaymentStatus, linkCheckoutRequestId } from '../lib/store.js';

function normalizePhoneNumber(phone) {
    // BluePay's documented format is 254xxxxxxxxx (e.g. 254712345678).
    // Defensive normalization since we don't control what shape the
    // frontend sends — handles 0-prefixed, bare 9-digit, or already
    // correct 254-prefixed input.
    const digits = String(phone).replace(/\D/g, '');
    if (digits.startsWith('254')) return digits;
    if (digits.startsWith('0')) return '254' + digits.slice(1);
    return '254' + digits;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Method not allowed' });
    }

    const { phone_number, amount, reference, loan_limit, applicant } = req.body || {};

    if (!phone_number || !amount) {
        return res.status(400).json({ success: false, message: 'Missing phone_number or amount' });
    }

    if (!reference) {
        console.error('Missing reference in request body — frontend must generate and send one');
        return res.status(400).json({ success: false, message: 'Missing reference' });
    }

    if (!process.env.BLUEPAY_BASIC_AUTH || !process.env.BLUEPAY_CHANNEL_ID || !process.env.BLUEPAY_BASE_URL) {
        console.error('Missing BLUEPAY_BASIC_AUTH, BLUEPAY_CHANNEL_ID, or BLUEPAY_BASE_URL environment variable');
        return res.status(500).json({ success: false, message: 'Payment provider not configured' });
    }

    const normalizedPhone = normalizePhoneNumber(phone_number);
    const endpoint = `${process.env.BLUEPAY_BASE_URL}/api/stk_push.php`;

    try {
        // TODO: persist the application (applicant, loan_limit) to your
        // real database here — the store below only tracks payment status.
        setPaymentStatus(reference, {
            status: 'PENDING',
            amount,
            phone_number: normalizedPhone,
            loan_limit
        });

        console.log('Calling BluePay:', endpoint, 'phone:', normalizedPhone, 'amount:', amount, 'our reference:', reference);

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Authorization': process.env.BLUEPAY_BASIC_AUTH,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                channel_id: process.env.BLUEPAY_CHANNEL_ID,
                phone: normalizedPhone,
                amount: Math.round(Number(amount))
                // account_reference intentionally omitted — see the note
                // at the top of this file. BluePay auto-generates a
                // correctly-prefixed one and returns it below.
            })
        });

        console.log('BluePay response status:', response.status);

        // Read as text first — if BluePay ever returns a non-JSON error
        // page (auth failure, 5xx, etc.) response.json() would throw and
        // get swallowed by the generic catch-block 502 below, hiding the
        // real cause. Logging the raw body first keeps that visible.
        const raw = await response.text();
        console.log('BluePay response body:', raw);

        let body;
        try {
            body = JSON.parse(raw);
        } catch {
            console.error('BluePay returned non-JSON response:', raw);
            setPaymentStatus(reference, { status: 'FAILED', error: raw });
            return res.status(502).json({ success: false, message: 'Payment provider returned an unexpected response' });
        }

        if (!response.ok || !body.ok) {
            console.error('BluePay payment initiation failed:', body);
            setPaymentStatus(reference, { status: 'FAILED', error: body });
            return res.status(502).json({
                success: false,
                message: body.message || 'Could not reach payment provider'
            });
        }

        // status here just means the request was accepted and the STK
        // push is going out — not that the customer has paid. Real
        // confirmation comes from BluePay's signed (HMAC-SHA256) webhook
        // (api/bluepay-callback.js), which api/payment-status.js reports
        // back to the frontend.
        //
        // BluePay's webhook carries checkout_request_id, not our own
        // reference — link it back so the webhook handler can translate
        // it to our reference.
        linkCheckoutRequestId(body.checkout_request_id, reference);
        setPaymentStatus(reference, {
            status: 'PENDING',
            stkRequestId: body.stk_request_id,
            checkoutRequestId: body.checkout_request_id,
            bluepayAccountReference: body.account_reference // BluePay-assigned, informational only
        });

        return res.status(200).json({
            success: true,
            reference,
            checkout_request_id: body.checkout_request_id
        });

    } catch (err) {
        console.error('BluePay request error:', err.name, err.message, err.cause || '');
        setPaymentStatus(reference, { status: 'FAILED', error: String(err) });
        return res.status(502).json({ success: false, message: 'Could not reach payment provider' });
    }
}
