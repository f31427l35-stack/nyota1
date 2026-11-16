
/**
 * POST /api/initiate-payment
 * UpesiPay STK Push
 */

const BASE_URL = 'https://api.upesipay.com';

function normalizePhoneNumber(phone) {
    const digits = String(phone).replace(/\D/g, '');

    if (digits.startsWith('254')) return digits;
    if (digits.startsWith('0')) return '254' + digits.slice(1);
    if (digits.startsWith('7') || digits.startsWith('1')) {
        return '254' + digits;
    }

    return digits;
}

export const maxDuration = 30;

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({
            success: false,
            message: 'Method not allowed'
        });
    }

    const { phone_number, amount, reference } = req.body || {};

    if (!phone_number || !amount || !reference) {
        return res.status(400).json({
            success: false,
            message: 'Missing phone_number, amount or reference'
        });
    }

    const numericAmount = Number(amount);

    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
        return res.status(400).json({
            success: false,
            message: 'Invalid payment amount'
        });
    }

    const username = process.env.UPESIPAY_USERNAME;
    const password = process.env.UPESIPAY_PASSWORD;
    const channelId = process.env.UPESIPAY_CHANNEL_ID || 'wallet';

    if (!username || !password) {
        console.error('Missing UpesiPay credentials');

        return res.status(500).json({
            success: false,
            message: 'Payment provider not configured'
        });
    }

    const auth = Buffer.from(`${username}:${password}`).toString('base64');

    try {
        const response = await fetch(
            `${BASE_URL}/api/v2/collections/initiate/`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    phone_number: normalizePhoneNumber(phone_number),
                    amount: Math.round(numericAmount),
                    reference,
                    channel_id: channelId
                })
            }
        );

        const raw = await response.text();

        let body;

        try {
            body = JSON.parse(raw);
        } catch {
            console.error('Invalid UpesiPay response:', raw);

            return res.status(502).json({
                success: false,
                message: 'Unexpected payment provider response'
            });
        }

        if (!response.ok) {
            console.error('UpesiPay initiation failed:', body);

            return res.status(502).json({
                success: false,
                message: body.message || 'Could not initiate payment'
            });
        }

        return res.status(200).json({
            success: true,
            reference,
            ...body
        });

    } catch (error) {
        console.error('UpesiPay error:', error.message);

        return res.status(502).json({
            success: false,
            message: 'Could not reach payment provider'
        });
    }
}
