/**
 * Vercel Serverless Function
 * POST /api/initiate-payment
 *
 * Called by the frontend when the user taps "Proceed to Payment".
 * Reads your UpesiPay credentials from Vercel Environment Variables (never
 * from the frontend) and triggers a real STK push through UpesiPay.
 *
 * Set these in your Vercel project:
 *   Project -> Settings -> Environment Variables
 *     UPESIPAY_API_USERNAME  Your API Username from the UpesiPay dashboard
 *                             (20 chars).
 *     UPESIPAY_API_PASSWORD  Your API Password from the UpesiPay dashboard
 *                             (40 chars).
 *
 *   We build the "Authorization: Basic <token>" header ourselves as
 *   base64("username:password") — the standard HTTP Basic Auth encoding.
 *   Pasting whatever "Auth Token" string their dashboard displays directly
 *   into a Bearer/Basic header caused 401 "Invalid authentication token
 *   format" errors, since it's ambiguous whether that displayed value is
 *   already base64-encoded or not. Encoding it ourselves from the raw
 *   username/password removes that ambiguity.
 *
 *     UPESIPAY_CHANNEL_ID    Optional. Your registered payment channel ID
 *                            (integer), or "wallet" to use the free system
 *                            M-PESA channel with no per-transaction charge.
 *                            Defaults to "wallet" if unset.
 *
 * FOR TESTING: UpesiPay doesn't document a separate sandbox mode the way
 * Sendit did — there's no PLATFORM_ENV toggle mentioned in their docs.
 * Treat requests as hitting live M-PESA unless/until UpesiPay documents
 * otherwise; check with them directly before testing with real phones.
 *
 * NOTE ON ARCHITECTURE (carried over from the Sendit/Paywave integration):
 * UpesiPay exposes a real transaction-status endpoint
 * (GET /api/v2/transaction-status). That means api/payment-status.js
 * queries UpesiPay directly on every poll, same pattern as before — see
 * that file and api/upesipay-callback.js for how that plays out.
 *
 * One IMPORTANT difference from Sendit: UpesiPay's STK callback posts
 * directly to the callback_url you supply below — it does NOT terminate
 * on UpesiPay's own servers first. That means api/upesipay-callback.js is
 * now live traffic (not a dormant optional feature like the old
 * sendit-callback.js was). UpesiPay's docs don't mention any
 * signature/HMAC verification on that callback, so it's still treated as
 * unverified — see that file for details.
 */

const UPESIPAY_BASE_URL = 'https://upesipay.com/api/v2';

function getBasicAuthHeader() {
    const username = process.env.UPESIPAY_API_USERNAME;
    const password = process.env.UPESIPAY_API_PASSWORD;
    if (!username || !password) return null;
    return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function normalizePhoneNumber(phone) {
    // UpesiPay's docs show 254-prefixed numbers (e.g. 254712345678) in every
    // example, so normalize the same way we did for Sendit.
    const digits = String(phone).replace(/\D/g, '');
    if (digits.startsWith('254')) return digits;
    if (digits.startsWith('0')) return '254' + digits.slice(1);
    return '254' + digits;
}

export const maxDuration = 30; // seconds — Vercel's default limit vs real STK response times

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Method not allowed' });
    }

    const { phone_number, amount, reference, name } = req.body || {};

    if (!phone_number || !amount) {
        return res.status(400).json({ success: false, message: 'Missing phone_number or amount' });
    }

    if (!reference) {
        return res.status(400).json({ success: false, message: 'Missing reference' });
    }

    const authHeader = getBasicAuthHeader();
    if (!authHeader) {
        console.error('Missing UPESIPAY_API_USERNAME or UPESIPAY_API_PASSWORD environment variable');
        return res.status(500).json({ success: false, message: 'Payment provider not configured' });
    }

    const normalizedPhone = normalizePhoneNumber(phone_number);
    const channelId = process.env.UPESIPAY_CHANNEL_ID || 'wallet';

    // Build our own callback URL from the incoming request so this works
    // across preview/production deployments without hardcoding a domain.
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const callbackUrl = `${proto}://${host}/api/upesipay-callback`;

    try {
        console.log('Calling UpesiPay:', `${UPESIPAY_BASE_URL}/collections/initiate/`, 'phone:', normalizedPhone, 'amount:', amount, 'reference:', reference);

        const response = await fetch(`${UPESIPAY_BASE_URL}/collections/initiate/`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': authHeader
            },
            body: JSON.stringify({
                channel_id: /^\d+$/.test(channelId) ? Number(channelId) : channelId,
                phone_number: normalizedPhone,
                amount: Math.round(Number(amount)),
                callback_url: callbackUrl
            })
        });

        console.log('UpesiPay response status:', response.status);

        const raw = await response.text();
        console.log('UpesiPay response body:', raw);

        let body;
        try {
            body = JSON.parse(raw);
        } catch {
            console.error('UpesiPay returned non-JSON response:', raw);
            return res.status(502).json({ success: false, message: 'Payment provider returned an unexpected response' });
        }

        // UpesiPay's success shape is { success: true, data: { checkout_request_id, merchant_request_id, ... } };
        // failures are { success: false, message, error_code }. checkout_request_id
        // presence is the real signal of success, same principle as the
        // CheckoutRequestID check this replaced.
        if (!response.ok || !body.success || !body.data?.checkout_request_id) {
            console.error('UpesiPay STK push failed:', body);
            return res.status(502).json({
                success: false,
                message: body.message || 'Could not reach payment provider'
            });
        }

        // The frontend polls on transaction_request_id — map UpesiPay's
        // checkout_request_id onto that same field name so index.html needs
        // no changes at all.
        return res.status(200).json({
            success: true,
            reference,
            transaction_request_id: body.data.checkout_request_id,
            checkout_request_id: body.data.checkout_request_id,
            merchant_request_id: body.data.merchant_request_id
        });

    } catch (err) {
        console.error('UpesiPay request error:', err.name, err.message, err.cause || '');
        return res.status(502).json({ success: false, message: 'Could not reach payment provider' });
    }
}
