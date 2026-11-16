
/**
 * GET /api/payment-status?reference=XXXXXXXX
 * UpesiPay transaction status
 */

const BASE_URL = 'https://upesipay.com';

export default async function handler(req, res) {
    if (req.method !== 'GET') {
        return res.status(405).json({
            status: 'ERROR',
            message: 'Method not allowed'
        });
    }

    const reference = req.query.reference;

    if (!reference) {
        return res.status(400).json({
            status: 'ERROR',
            message: 'Missing reference'
        });
    }

    const username = process.env.UPESIPAY_USERNAME;
    const password = process.env.UPESIPAY_PASSWORD;

    if (!username || !password) {
        return res.status(500).json({
            status: 'ERROR',
            message: 'Payment provider not configured'
        });
    }

    const auth = Buffer.from(`${username}:${password}`).toString('base64');

    try {
        const response = await fetch(
            `${BASE_URL}/api/v2/transaction-status?reference=${encodeURIComponent(reference)}`,
            {
                method: 'GET',
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        const raw = await response.text();

        let body;

        try {
            body = JSON.parse(raw);
        } catch {
            console.error('Invalid UpesiPay status response:', raw);

            return res.status(200).json({
                status: 'PENDING'
            });
        }

        if (!response.ok) {
            console.error('UpesiPay status error:', body);

            return res.status(200).json({
                status: 'PENDING'
            });
        }

        const transactionStatus = String(
            body.status || body.transaction_status || ''
        ).toLowerCase();

        let status = 'PENDING';

        if (['success', 'successful', 'completed', 'paid'].includes(transactionStatus)) {
            status = 'SUCCESS';
        } else if (['failed', 'cancelled', 'canceled', 'rejected', 'expired'].includes(transactionStatus)) {
            status = 'FAILED';
        }

        return res.status(200).json({
            status,
            receipt: body.receipt || body.transaction_id || null,
            amount: body.amount || null
        });

    } catch (error) {
        console.error('UpesiPay status error:', error.message);

        return res.status(200).json({
            status: 'PENDING'
        });
    }
}
