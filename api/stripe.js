// api/stripe.js — Vercel serverless function
// Secure proxy for all Stripe API calls. Secret key never touches the browser.

const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
const STRIPE_API    = 'https://api.stripe.com/v1';

// Small fetch wrapper for Stripe's form-encoded API
async function stripeRequest(method, path, params = {}) {
  const body = method !== 'GET'
    ? new URLSearchParams(flattenParams(params)).toString()
    : null;

  const url = method === 'GET' && Object.keys(params).length
    ? `${STRIPE_API}${path}?${new URLSearchParams(flattenParams(params))}`
    : `${STRIPE_API}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${STRIPE_SECRET}`,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    ...(body ? { body } : {}),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Stripe error ${res.status}`);
  return data;
}

// Flatten nested objects for Stripe's form encoding
// e.g. { metadata: { foo: 'bar' } } → { 'metadata[foo]': 'bar' }
function flattenParams(obj, prefix = '') {
  return Object.entries(obj).reduce((acc, [key, val]) => {
    const k = prefix ? `${prefix}[${key}]` : key;
    if (val === null || val === undefined) return acc;
    if (typeof val === 'object' && !Array.isArray(val)) {
      Object.assign(acc, flattenParams(val, k));
    } else if (Array.isArray(val)) {
      val.forEach((v, i) => { acc[`${k}[${i}]`] = v; });
    } else {
      acc[k] = val;
    }
    return acc;
  }, {});
}

export default async function handler(req, res) {
  // CORS — only allow your own Vercel domain in production
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!STRIPE_SECRET) return res.status(500).json({ error: 'STRIPE_SECRET_KEY not configured' });

  const { action, payload } = req.body;

  try {
    switch (action) {

      // ── Find or create Stripe customer ───────────────────────
      case 'find_or_create_customer': {
        const { name, email } = payload;
        if (!email) throw new Error('Client email is required to create a Stripe customer');

        // Search for existing customer by email
        const search = await stripeRequest('GET', '/customers', {
          email,
          limit: 1,
        });

        if (search.data && search.data.length > 0) {
          return res.json({ customer: search.data[0], created: false });
        }

        // None found — create new
        const customer = await stripeRequest('POST', '/customers', { name, email });
        return res.json({ customer, created: true });
      }

      // ── Push full invoice to Stripe ──────────────────────────
      case 'create_invoice': {
        const {
          customer_id,
          line_items,
          stripe_fee_item,
          currency = 'usd',
          invoice_log_id,
          client_name,
        } = payload;

        // 1. Create the invoice shell first — draft, auto_advance OFF
        const invoice = await stripeRequest('POST', '/invoices', {
          customer:          customer_id,
          collection_method: 'send_invoice',
          days_until_due:    30,
          auto_advance:      false,
          metadata: {
            invoice_log_id: invoice_log_id || '',
            client:         client_name    || '',
          },
        });

        // 2. Create line items pinned directly to this invoice
        for (const item of line_items) {
          await stripeRequest('POST', '/invoiceitems', {
            customer:    customer_id,
            invoice:     invoice.id,
            amount:      item.amount_cents,
            currency,
            description: item.description,
          });
        }

        // 3. Stripe fee recovery item if applicable
        if (stripe_fee_item) {
          await stripeRequest('POST', '/invoiceitems', {
            customer:    customer_id,
            invoice:     invoice.id,
            amount:      stripe_fee_item.amount_cents,
            currency,
            description: stripe_fee_item.description,
          });
        }

        // 4. Return draft — do NOT finalize, do NOT send
        return res.json({
          stripe_invoice_id:  invoice.id,
          hosted_invoice_url: invoice.hosted_invoice_url || null,
          status:             invoice.status,
        });
      }

      // ── Get invoice status from Stripe ───────────────────────
      case 'get_invoice_status': {
        const { stripe_invoice_id } = payload;
        const invoice = await stripeRequest('GET', `/invoices/${stripe_invoice_id}`);
        return res.json({
          status:             invoice.status,
          hosted_invoice_url: invoice.hosted_invoice_url,
          amount_due:         invoice.amount_due,
          amount_paid:        invoice.amount_paid,
        });
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error('Stripe API error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
