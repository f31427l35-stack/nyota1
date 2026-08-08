/**
 * Vercel Serverless Function
 * POST /api/upesipay-callback
 *
 * UNLIKE the old Sendit setup, this endpoint is now LIVE, not optional.
 * UpesiPay's real M-PESA callback posts directly here (see the
 * callback_url built in initiate-payment.js) — there's no "it terminates
 * on the provider's own servers" indirection the way Sendit's did.
 *
 * UpesiPay's docs don't mention any signature/HMAC verification on this
 * webhook, and they explicitly say the transaction is already marked
 * complete on their side before they send it — i.e. it's a notification,
 * not proof. So, same rule as the old Sendit/Paywave callback handlers:
 * this deliberately does NOT update any payment status based on what it
 * receives here. It only logs, for visibility/debugging. The trusted path
 * for final success/failure stays api/payment-status.js polling UpesiPay's
 * /api/v2/transaction-status directly with our own auth token.
 *
 * If UpesiPay later documents signature verification for this callback,
 * this is the file to update — verify first, then it would be safe to let
 * this also update a store directly rather than just logging.
 *
 * UpesiPay requires a 200-204 response within 5 seconds and does NOT
 * retry on failure, so keep this handler fast and side-effect-free.
 */
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ status: 'received' });
    }
    console.log('UpesiPay webhook received (UNVERIFIED — logged only, not trusted):', JSON.stringify(req.body, null, 2));
    // Deliberately no status update here — see the note above.
    res.status(200).json({ status: 'received' });
}
