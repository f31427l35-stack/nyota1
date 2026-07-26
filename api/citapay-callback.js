/**
 * Vercel Serverless Function
 * POST /api/paywavexpress-callback
 *
 * Register this URL (https://your-app.vercel.app/api/paywavexpress-callback)
 * in the Paywave Express dashboard under your account's webhook settings.
 *
 * IMPORTANT — WHY THIS DOESN'T MARK ANYTHING AS PAID:
 * Paywave Express's docs describe no signature verification scheme for
 * this webhook at all (no HMAC, no secret, nothing to check). That means
 * anyone who discovers this URL could POST a fake "success" payload with
 * no way for us to tell it apart from a real one. So this handler
 * deliberately does NOT update any payment status based on what it
 * receives — it only logs the event for visibility/debugging.
 *
 * The actual source of truth for payment status is
 * api/payment-status.js, which queries Paywave Express's own
 * /v1/tstatus endpoint directly (authenticated with our API key) every
 * time the frontend polls. That can't be spoofed the way an open webhook
 * can, since it requires our real credentials to even ask the question.
 *
 * If Paywave Express later adds webhook signing, this is the file to
 * update — verify first, then it would be safe to let this also update a
 * store directly rather than just logging.
 */

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ status: 'received' });
    }

    console.log('Paywave Express webhook received (UNVERIFIED — logged only, not trusted):', JSON.stringify(req.body, null, 2));

    // Deliberately no status update here — see the note above.

    res.status(200).json({ status: 'received' });
}
