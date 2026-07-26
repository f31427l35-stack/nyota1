/**
 * Vercel Serverless Function
 * POST /api/initiate-payment
 *
 * Called by the frontend when the user taps "Proceed to Payment".
 * Reads your Paywave Express credentials from Vercel Environment
 * Variables (never from the frontend) and triggers a real STK push.
 *
 * Set these in your Vercel project:
 *   Project -> Settings -> Environment Variables
 *     PAYWAVEXPRESS_API_KEY   (from your Paywave Express dashboard)
 *     PAYWAVEXPRESS_EMAIL     (the email registered on that account)
 *
 * NOTE ON ARCHITECTURE: unlike the other providers integrated today,
 * Paywave Express exposes a real transaction-status endpoint
 * (POST /v1/tstatus). That means api/payment-status.js queries THEM
 * directly on every poll, rather than relying on a webhook having
 * already updated a local in-memory store — which sidesteps the
 * cross-function in-memory-store reliability problem entirely for this
 * provider. See api/payment-status.js and api/paywavexpress-callback.js
 * for how that plays out.
 */

const BASE_URL = 'https://paywavexpress.co.ke';

function normalizePhoneNumber(phone) {
    // Docs show both 0712345678 and 254712345678 as accepted formats, so
    // minimal normalization is needed — just strip non-digits and ensure
    // a 254-prefixed shape, which is the safest common denominator.
    const digits = String(phone).replace(/\D/g, '');
    if (digits.startsWith('254')) return digits;
    if (digits.startsWith('0')) return '254' + digits.slice(1);
    return '254' + digits;
}

export const maxDuration = 30; // seconds — see the note in every other provider's file today about Vercel's default limit vs real STK response times

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Method not allowed' });
    }

    const { phone_number, amount, reference, loan_limit } = req.body || {};

    if (!phone_number || !amount) {
        return res.status(400).json({ success: false, message: 'Missing phone_number or amount' });
    }

    if (!reference) {
        return res.status(400).json({ success: false, message: 'Missing reference' });
    }

    if (!process.env.PAYWAVEXPRESS_API_KEY || !process.env.PAYWAVEXPRESS_EMAIL) {
        console.error('Missing PAYWAVEXPRESS_API_KEY or PAYWAVEXPRESS_EMAIL environment variable');
        return res.status(500).json({ success: false, message: 'Payment provider not configured' });
    }

    const normalizedPhone = normalizePhoneNumber(phone_number);

    try {
        console.log('Calling Paywave Express:', `${BASE_URL}/v1/stkpush`, 'phone:', normalizedPhone, 'amount:', amount, 'reference:', reference);

        const response = await fetch(`${BASE_URL}/v1/stkpush`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                api_key: process.env.PAYWAVEXPRESS_API_KEY,
                email: process.env.PAYWAVEXPRESS_EMAIL,
                amount: String(Math.round(Number(amount))),
                msisdn: normalizedPhone,
                reference
                // account_number omitted — only required for Paybill-type
                // linked accounts. Add it here if this account is a Paybill.
            })
        });

        console.log('Paywave Express response status:', response.status);

        const raw = await response.text();
        console.log('Paywave Express response body:', raw);

        let body;
        try {
            body = JSON.parse(raw);
        } catch {
            console.error('Paywave Express returned non-JSON response:', raw);
            return res.status(502).json({ success: false, message: 'Payment provider returned an unexpected response' });
        }

        // Docs show success responses use "success"/"ResponseCode", and
        // error responses use "ResultCode"/"errorMessage" — check for the
        // presence of transaction_request_id as the actual signal of
        // success, since that's what every downstream step depends on.
        if (!response.ok || !body.transaction_request_id) {
            console.error('Paywave Express STK push failed:', body);
            return res.status(502).json({
                success: false,
                message: body.errorMessage || body.message || 'Could not reach payment provider'
            });
        }

        // transaction_request_id is what /v1/tstatus is queried with —
        // send it back to the frontend so polling can use it directly,
        // no separate store lookup required.
        return res.status(200).json({
            success: true,
            reference,
            transaction_request_id: body.transaction_request_id,
            checkout_request_id: body.CheckoutRequestID
        });

    } catch (err) {
        console.error('Paywave Express request error:', err.name, err.message, err.cause || '');
        return res.status(502).json({ success: false, message: 'Could not reach payment provider' });
    }
}
