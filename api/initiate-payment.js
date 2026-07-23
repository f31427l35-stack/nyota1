/**
 * Vercel Serverless Function
 * POST /api/initiate-payment
 *
 * Called by the frontend when the user taps "Proceed to Payment".
 * Reads your CitaPay secret key from Vercel Environment Variables (never
 * from the frontend) and triggers a real STK push via CitaPay's
 * Payments API.
 *
 * Set these in your Vercel project:
 *   Project -> Settings -> Environment Variables
 *     CITAPAY_API_KEY       (sk_test_... while testing, sk_live_... when live)
 *     CITAPAY_ENV           ("sandbox" or "production" — defaults to sandbox)
 */

import crypto from 'crypto';
import { setPaymentStatus, linkCheckoutRequestId } from '../lib/store.js';

function getBaseUrl() {
    return process.env.CITAPAY_ENV === 'production'
        ? 'https://citapayapi.citatech.cloud/api/v1'
        : 'https://sandbox.citapayapi.citatech.cloud/api/v1';
}

// Vercel's default execution limit (10s on the Hobby plan) can be shorter
// than CitaPay's real-world response time, especially in sandbox (which
// routes through the actual Daraja Sandbox, per their docs). If the
// function gets killed before CitaPay responds, the browser sees a
// timeout/502 even though CitaPay already received and is processing the
// request — which is exactly why an STK push can still arrive on the
// phone right after the app shows an error. Giving this more headroom
// lets the function actually wait for the real response instead of
// getting cut off mid-flight.
export const maxDuration = 30; // seconds — raise further if still timing out

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, message: 'Method not allowed' });
    }

    const { phone_number, amount, reference, loan_limit, applicant } = req.body || {};

    if (!phone_number || !amount) {
        return res.status(400).json({ success: false, message: 'Missing phone_number or amount' });
    }

    if (!process.env.CITAPAY_API_KEY) {
        console.error('Missing CITAPAY_API_KEY environment variable');
        return res.status(500).json({ success: false, message: 'Payment provider not configured' });
    }

    try {
        // TODO: persist the application (applicant, loan_limit) to your
        // real database here — the store below only tracks payment status.
        setPaymentStatus(reference, {
            status: 'PENDING',
            amount,
            phone_number,
            loan_limit
        });

        const response = await fetch(`${getBaseUrl()}/checkout/payments`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${process.env.CITAPAY_API_KEY}`,
                'Content-Type': 'application/json',
                // A fresh key per logical request — prevents a network
                // retry/double-tap from creating a duplicate STK push.
                'Idempotency-Key': crypto.randomUUID()
            },
            body: JSON.stringify({
                amount,
                paymentMethod: 'MPESA',
                phoneNumber: phone_number,
                customerName: applicant?.full_name || undefined,
                metadata: {
                    our_reference: reference,
                    loan_limit
                }
            })
        });

        const data = await response.json();

        if (!response.ok) {
            console.error('CitaPay payment initiation failed:', data);
            setPaymentStatus(reference, { status: 'FAILED', error: data });
            return res.status(502).json({
                success: false,
                message: data.message || data.error || 'Could not reach payment provider'
            });
        }

        // status: "PENDING" here just means the request was accepted and
        // the STK push is going out — not that the customer has paid.
        // Real confirmation comes from the CitaPay webhook
        // (api/citapay-callback.js), which api/payment-status.js reports
        // back to the frontend.
        linkCheckoutRequestId(data.reference, reference);
        setPaymentStatus(reference, {
            status: 'PENDING',
            citapayTransactionId: data.transactionId,
            citapayReference: data.reference
        });

        return res.status(200).json({
            success: true,
            checkout_request_id: data.reference
        });

    } catch (err) {
        console.error('CitaPay request error:', err);
        setPaymentStatus(reference, { status: 'FAILED', error: String(err) });
        return res.status(502).json({ success: false, message: 'Could not reach payment provider' });
    }
}
