/**
 * notify-sales — emails sales@toolhound.com when a label order is filed.
 *
 * Invoked by a Supabase Database Webhook on INSERT into public.label_orders,
 * not by the browser. That matters: the order form submits directly from the
 * customer's browser with the anon key, so anything client-side could be
 * skipped by a crafted request, and a failing email would either block the
 * customer's submission or vanish silently. Firing off the database row means
 * every order that actually lands generates a notification, and a mail outage
 * never costs a customer their order.
 *
 * Configure (see README, "Notifications"):
 *   supabase secrets set RESEND_API_KEY=re_...
 *   supabase secrets set NOTIFY_WEBHOOK_SECRET=<long random string>
 *   supabase secrets set NOTIFY_TO=sales@toolhound.com
 *   supabase secrets set NOTIFY_FROM='ToolHound Orders <orders@toolhound.com>'
 *   supabase secrets set DASHBOARD_URL=https://tool-hound-label-order-form.vercel.app/admin
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

const LOGO_CHOICE_LABELS: Record<string, string> = {
  custom_logo: 'Custom Logo',
  custom_text: 'Custom Text',
  toolhound_logo: 'ToolHound Logo',
};

interface LabelOrder {
  order_ref: string;
  submitted_at: string;
  company_name: string;
  contact_name: string;
  contact_email: string;
  address: string;
  city: string;
  state_province: string;
  postal_code: string;
  country: string;
  logo_choice: string;
  logo_file_name: string | null;
  text_lines: string[] | null;
  full_color: string;
  quantity: number;
  start_seq: number;
  instructions: string | null;
  authorized_name: string;
  approval_date: string;
}

/**
 * Order details are customer-supplied free text landing in an HTML email, so
 * every interpolated value goes through this. Note that the uploaded artwork
 * (`logo_file_data`) is never included at all — an uploaded SVG can carry
 * script, so it is only ever handled as a download from the dashboard.
 */
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function labelSpec(order: LabelOrder): string {
  const choice = LOGO_CHOICE_LABELS[order.logo_choice] ?? order.logo_choice;
  if (order.logo_choice === 'custom_logo') {
    return `${choice} (artwork attached to the order: ${order.logo_file_name ?? 'unnamed file'})`;
  }
  if (order.logo_choice === 'custom_text') {
    const lines = (order.text_lines ?? []).filter((l) => l && l.trim());
    return lines.length ? `${choice} — ${lines.join(' / ')}` : choice;
  }
  return choice;
}

function sequenceRange(order: LabelOrder): string {
  const end = order.start_seq + order.quantity - 1;
  return `${order.start_seq} – ${end}`;
}

function buildEmail(order: LabelOrder, dashboardUrl: string) {
  const rows: Array<[string, string]> = [
    ['Order reference', order.order_ref],
    ['Company', order.company_name],
    ['Contact', `${order.contact_name} — ${order.contact_email}`],
    [
      'Ship to',
      [order.address, order.city, order.state_province, order.postal_code, order.country]
        .filter(Boolean)
        .join(', '),
    ],
    ['Label', labelSpec(order)],
    ['Full colour', order.full_color],
    ['Quantity', String(order.quantity)],
    ['Sequence range', sequenceRange(order)],
    ['Special instructions', order.instructions ?? '—'],
    ['Authorized by', `${order.authorized_name} on ${order.approval_date}`],
  ];

  const html = `
    <div style="font-family:Inter,Helvetica,Arial,sans-serif;color:#201B1A;max-width:600px">
      <h2 style="margin:0 0 4px;font-size:18px">New label order: ${esc(order.order_ref)}</h2>
      <p style="margin:0 0 20px;font-size:14px;color:#5B5352">
        ${esc(order.company_name)} authorized ${esc(order.quantity)} labels.
      </p>
      <table style="border-collapse:collapse;width:100%;font-size:14px">
        ${rows
          .map(
            ([k, v]) => `<tr>
              <td style="padding:7px 12px 7px 0;color:#5B5352;vertical-align:top;white-space:nowrap">${esc(k)}</td>
              <td style="padding:7px 0;font-weight:600">${esc(v)}</td>
            </tr>`,
          )
          .join('')}
      </table>
      <p style="margin:24px 0 0">
        <a href="${esc(dashboardUrl)}"
           style="background:#D72F2F;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:14px;font-weight:600;display:inline-block">
          Open the orders dashboard
        </a>
      </p>
      <p style="margin:20px 0 0;font-size:12px;color:#94a3b8">
        This order is marked <strong>Received</strong>. Update its status in the
        dashboard as the PO goes out, production confirms, and it ships.
      </p>
    </div>`;

  const text = [
    `New label order: ${order.order_ref}`,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    `Dashboard: ${dashboardUrl}`,
  ].join('\n');

  return { html, text };
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required secret: ${name}`);
  return value;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // The function URL is public, so the webhook proves itself with a shared
  // secret sent as a custom header. Without this anyone could post a fabricated
  // order straight to sales@.
  let webhookSecret: string;
  try {
    webhookSecret = requiredEnv('NOTIFY_WEBHOOK_SECRET');
  } catch (err) {
    console.error(err);
    return new Response('Not configured', { status: 500 });
  }
  if (req.headers.get('x-notify-secret') !== webhookSecret) {
    console.warn('Rejected notify-sales request with a bad or missing secret');
    return new Response('Unauthorized', { status: 401 });
  }

  let payload: { type?: string; table?: string; record?: LabelOrder };
  try {
    payload = await req.json();
  } catch {
    return new Response('Bad request', { status: 400 });
  }

  const order = payload.record;
  if (payload.type !== 'INSERT' || payload.table !== 'label_orders' || !order?.order_ref) {
    // Not an event this function handles. 200, not an error: a retry would
    // never make it one, and the webhook should not keep hammering.
    console.log('Ignoring event', payload.type, payload.table);
    return new Response(JSON.stringify({ ignored: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  let resendKey: string;
  let to: string;
  let from: string;
  try {
    resendKey = requiredEnv('RESEND_API_KEY');
    to = Deno.env.get('NOTIFY_TO') || 'sales@toolhound.com';
    from = requiredEnv('NOTIFY_FROM');
  } catch (err) {
    console.error(err);
    return new Response('Not configured', { status: 500 });
  }

  const dashboardUrl = Deno.env.get('DASHBOARD_URL') || '';
  const { html, text } = buildEmail(order, dashboardUrl);

  const res = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${resendKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: to.split(',').map((addr) => addr.trim()).filter(Boolean),
      reply_to: order.contact_email,
      subject: `New label order ${order.order_ref} — ${order.company_name} (${order.quantity} labels)`,
      html,
      text,
    }),
  });

  if (!res.ok) {
    // A non-2xx here is returned as a 500 on purpose: Supabase webhooks retry,
    // and a transient Resend failure is worth retrying.
    const body = await res.text();
    console.error('Resend rejected the notification', res.status, body);
    return new Response(JSON.stringify({ error: 'send_failed', status: res.status }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }

  console.log('Notified', to, 'about', order.order_ref);
  return new Response(JSON.stringify({ sent: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
});
