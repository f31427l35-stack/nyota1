
/**
 * POST /api/citapay-callback
 * UpesiPay callback endpoint
 *
 * Callback is logged only.
 * Payment confirmation must come from the
 * authenticated UpesiPay transaction-status API.
 */

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({
            status: 'received'
        });
    }

    console.log(
        'UpesiPay callback received:',
        JSON.stringify(req.body || {})
    );

    // Do not mark payments successful using an
    // unverified callback.

    return res.status(200).json({
        status: 'received'
    });
}
