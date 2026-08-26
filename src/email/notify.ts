import { Resend } from 'resend';
import { config } from '../config.js';

const resend = new Resend(config.resend.apiKey);

type RequestNotification = {
  requestId: string;
  type: string;
  name: string;
  phone: string;
  email?: string | null;
  companyName?: string | null;
  sector?: string | null;
  city?: string | null;
  title?: string | null;
  description?: string | null;
  details?: Record<string, any> | null;
};

const typeLabels: Record<string, string> = {
  service: 'Post Request',
  custom: 'Custom Requirement',
  plan: 'Plan Enquiry',
  influencer: 'Influencer Selection',
};

/** Make user-supplied text safe to place inside HTML */
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Turn a details value into readable text — arrays and objects included */
function renderValue(value: unknown): string {
  if (Array.isArray(value)) {
    return esc(value.join(', '));
  }
  if (value && typeof value === 'object') {
    return esc(JSON.stringify(value));
  }
  return esc(value);
}

/** camelCase key → readable label */
function labelKey(key: string): string {
  return esc(
    key.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase())
  );
}

export async function sendRequestNotification(data: RequestNotification) {
  const label = typeLabels[data.type] || data.type;

  const detailsHtml = data.details
    ? Object.entries(data.details)
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(
          ([key, value]) =>
            `<li style="margin-bottom:4px;">
               <strong>${labelKey(key)}:</strong> ${renderValue(value)}
             </li>`
        )
        .join('')
    : '';

  const html = `
    <div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:560px;">
      <div style="background:#FF6B35;color:#fff;padding:16px 20px;border-radius:10px 10px 0 0;">
        <div style="font-size:12px;opacity:0.85;letter-spacing:1px;">LASAN MART</div>
        <div style="font-size:20px;font-weight:700;margin-top:2px;">New ${esc(label)}</div>
      </div>

            <div style="border:1px solid #E0E0E0;border-top:none;border-radius:0 0 10px 10px;padding:20px;">
        ${
          data.title
            ? `<div style="font-size:16px;font-weight:700;color:#1A1A1A;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid #E0E0E0;">
                 ${esc(data.title)}
               </div>`
            : ''
        }

        <p style="margin:0 0 8px;"><strong>Name:</strong> ${esc(data.name)}</p>
        <p style="margin:0 0 8px;"><strong>Phone:</strong> ${esc(data.phone)}</p>
        ${data.email ? `<p style="margin:0 0 8px;"><strong>Email:</strong> ${esc(data.email)}</p>` : ''}
        ${data.companyName ? `<p style="margin:0 0 8px;"><strong>Company:</strong> ${esc(data.companyName)}</p>` : ''}
        ${data.sector ? `<p style="margin:0 0 8px;"><strong>Sector:</strong> ${esc(data.sector)}</p>` : ''}
        ${data.city ? `<p style="margin:0 0 8px;"><strong>City:</strong> ${esc(data.city)}</p>` : ''}

        ${
          data.description
            ? `<div style="background:#F5F5F5;border-radius:8px;padding:12px;margin:14px 0;">
                 <div style="font-size:11px;color:#767676;margin-bottom:4px;">DESCRIPTION</div>
                 ${esc(data.description).replace(/\n/g, '<br/>')}
               </div>`
            : ''
        }

        ${
          detailsHtml
            ? `<div style="font-size:11px;color:#767676;margin:14px 0 6px;">DETAILS</div>
               <ul style="margin:0;padding-left:18px;">${detailsHtml}</ul>`
            : ''
        }

        <p style="color:#999;font-size:11px;margin-top:20px;border-top:1px solid #E0E0E0;padding-top:12px;">
          Request ID: ${esc(data.requestId)}
        </p>
      </div>
    </div>
  `;

  const result = await resend.emails.send({
    from: config.resend.from,
    to: config.resend.to,
    replyTo: data.email || undefined,
    subject: `New ${label} — ${data.name} (${data.phone})`,
    html,
  });

  if (result.error) {
    throw new Error(result.error.message);
  }

  return result;
}