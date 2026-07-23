/**
 * Vercel Serverless Function
 * GET /api/payment-status?reference=XXXXXXXX
 *
 * Polled by the frontend after initiating a payment, so the UI only shows
 * "Success" once PayNexus's webhook (api/paynexus-callback.js) has actually
 * confirmed it — never based on the initial "queued" response alone.
 */

import { getPaymentStatus } from '../lib/store.js';

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({ status: 'ERROR', message: 'Method not allowed' });
    }

    const { reference } = req.query;

    if (!reference) {
        return res.status(400).json({ status: 'ERROR', message: 'Missing reference' });
    }

    const record = getPaymentStatus(reference);

    if (!record) {
        return res.status(404).json({ status: 'UNKNOWN', message: 'No record for this reference yet' });
    }

    const response = { status: record.status, updatedAt: record.updatedAt };
    if (record.status === 'FAILED' && record.userMessage) {
        response.message = record.userMessage;
    }

    return res.status(200).json(response);
}
