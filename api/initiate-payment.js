/**
 * Vercel Serverless Function
 * POST /api/initiate-payment
 *
 * Called by the frontend when the user taps "Proceed to Payment".
 * Reads your PayNexus secret key from Vercel Environment Variables (never
 * from the frontend) and triggers a real STK push via PayNexus's
 * STK Push API.
 *
 * Set these in your Vercel project:
 *   Project -> Settings -> Environment Variables
 *     PAYNEXUS_SECRET_KEY   (sk_... from your PayNexus dashboard)
 */

import { setPaymentStatus, linkCheckoutRequestId } from '../lib/store.js';

const BASE_URL = 'https://paynexus.co.ke/api';

function normalizePhoneNumber(phone) {
    // PayNexus's documented format is 0xxxxxxxxx (e.g. 0746990866).
    // Defensive normalization since we don't control what shape the
    // frontend sends — handles 254-prefixed, bare 9-digit, or already
    // correct 0-prefixed input.
    const digits = String(phone).replace(/\D/g, '');
    if (digits.startsWith('0')) return digits;
    if (digits.startsWith('254')) return '0' + digits.slice(3);
    return '0' + digits;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Method not allowed' });
    }

    const { phone_number, amount, reference, loan_limit, applicant } = req.body || {};

    if (!phone_number || !amount) {
        return res.status(400).json({ success: false, message: 'Missing phone_number or amount' });
    }

    if (!process.env.PAYNEXUS_SECRET_KEY) {
        console.error('Missing PAYNEXUS_SECRET_KEY environment variable');
        return res.status(500).json({ success: false, message: 'Payment provider not configured' });
    }

    const normalizedPhone = normalizePhoneNumber(phone_number);

    try {
        // TODO: persist the application (applicant, loan_limit) to your
        // real database here — the store below only tracks payment status.
        setPaymentStatus(reference, {
            status: 'PENDING',
            amount,
            phone_number: normalizedPhone,
            loan_limit
        });

        const response = await fetch(`${BASE_URL}/mpesa/payment/initiate`, {
            method: 'POST',
            headers: {
                'X-API-Key': process.env.PAYNEXUS_SECRET_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                amount: Math.round(Number(amount)),
                phone: normalizedPhone,
                description: applicant?.full_name
                    ? `Loan application - ${applicant.full_name}`
                    : `Loan application ${reference}`
            })
        });

        const body = await response.json();

        if (!response.ok || !body.success) {
            console.error('PayNexus payment initiation failed:', body);
            setPaymentStatus(reference, { status: 'FAILED', error: body });
            return res.status(502).json({
                success: false,
                message: body.message || 'Could not reach payment provider'
            });
        }

        const data = body.data || {};

        // status here just means the request was accepted and the STK
        // push is going out — not that the customer has paid. Real
        // confirmation comes from the PayNexus webhook
        // (api/paynexus-callback.js), which api/payment-status.js reports
        // back to the frontend.
        //
        // PayNexus generates ITS OWN reference (unlike our pre-generated
        // one) — link it back to our reference so the webhook, which only
        // carries PayNexus's reference, can be translated back to ours.
        linkCheckoutRequestId(data.reference, reference);
        setPaymentStatus(reference, {
            status: 'PENDING',
            paynexusReference: data.reference,
            checkoutRequestId: data.checkout_request_id
        });

        return res.status(200).json({
            success: true,
            checkout_request_id: data.checkout_request_id
        });

    } catch (err) {
        console.error('PayNexus request error:', err);
        setPaymentStatus(reference, { status: 'FAILED', error: String(err) });
        return res.status(502).json({ success: false, message: 'Could not reach payment provider' });
    }
}
