/**
 * Minimal shared store, keyed by payment reference.
 *
 * IMPORTANT LIMITATION: Vercel serverless functions are stateless and can
 * run as separate parallel instances — a plain in-memory Map only reliably
 * works while a function stays "warm" on the same instance, which is fine
 * for testing/demoing this prototype but is NOT safe to rely on in
 * production. Before a real launch, swap this for a real store such as
 * Vercel KV, Upstash Redis, or a database table keyed by `reference`.
 * The get/set interface below is intentionally tiny so that swap is a
 * one-file change.
 */

const store = globalThis.__nyotaPaymentStore || (globalThis.__nyotaPaymentStore = new Map());

export function setPaymentStatus(reference, data) {
    store.set(reference, { ...(store.get(reference) || {}), ...data, updatedAt: Date.now() });
}

export function getPaymentStatus(reference) {
    return store.get(reference) || null;
}

// Payment provider webhooks often identify transactions by their own
// reference/ID rather than ours, so we keep a small index to translate one to the other.
export function linkCheckoutRequestId(checkoutRequestId, reference) {
    store.set(`checkout:${checkoutRequestId}`, reference);
}

export function getReferenceByCheckoutRequestId(checkoutRequestId) {
    return store.get(`checkout:${checkoutRequestId}`) || null;
}
