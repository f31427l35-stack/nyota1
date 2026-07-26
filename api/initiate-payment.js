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
 * *** TEMPORARY DEBUG BUILD ***
 * This version logs a safe, partial preview of BLUEPAY_BASIC_AUTH and the
 * full BLUEPAY_CHANNEL_ID right before the request goes out, so we can
 * prove — from the actual Vercel function logs, not guesswork — exactly
 * what value is really stored and being sent as the Authorization header
 * on the live deployment. Only a short prefix + length of the secret is
 * logged, never the full value. REMOVE this debug block once resolved.
 */

import { setPaymentStatus, linkCheckoutRequestId } from '../lib/store.js';

function normalizePhoneNumber(phone) {
    const digits = String(phone).replace(/\D/g, '');
    if (digits.startsWith('254')) return digits;
    if (digits.startsWith('0')) return '254' + digits.slice(1);
    return '254' + digits;
}

export const maxDuration = 30; // seconds

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

    // ─── TEMPORARY DEBUG — proves what's actually stored, right now ───
    const authVal = String(process.env.BLUEPAY_BASIC_AUTH);
    console.log('DEBUG BLUEPAY_BASIC_AUTH — first 20 chars:', JSON.stringify(authVal.slice(0, 20)));
    console.log('DEBUG BLUEPAY_BASIC_AUTH — length:', authVal.length);
    console.log('DEBUG BLUEPAY_BASIC_AUTH — starts with "Basic ":', authVal.startsWith('Basic '));
    console.log('DEBUG BLUEPAY_BASIC_AUTH — starts with "Bearer ":', authVal.startsWith('Bearer '));
    console.log('DEBUG BLUEPAY_CHANNEL_ID — full value:', process.env.BLUEPAY_CHANNEL_ID);
    // ─── END TEMPORARY DEBUG ───

    const normalizedPhone = normalizePhoneNumber(phone_number);
    const endpoint = `${process.env.BLUEPAY_BASE_URL}/api/stk_push.php`;

    try {
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
            })
        });

        console.log('BluePay response status:', response.status);

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

        linkCheckoutRequestId(body.checkout_request_id, reference);
        setPaymentStatus(reference, {
            status: 'PENDING',
            stkRequestId: body.stk_request_id,
            checkoutRequestId: body.checkout_request_id,
            bluepayAccountReference: body.account_reference
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
