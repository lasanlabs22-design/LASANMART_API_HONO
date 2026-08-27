import { Resend } from 'resend';
import { config } from '../config.js';

const resend = new Resend(config.resend.apiKey);

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

type AssignPayload = {
  to: string;
  note: string;
  request: {
    id: string;
    type: string;
    title: string | null;
    description: string | null;
    details: Record<string, any> | null;
    created_at: string;
    name: string;
    phone: string;
    email: string | null;
    company_name: string | null;
    sector: string | null;
    city: string | null;
  };
};

export async function sendAssignmentEmail({ to, note, request }: AssignPayload) {
  const r = request;

  const detailRows = r.details
    ? Object.entries(r.details)
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(
          ([k, v]) =>
            `<tr>
               <td style="padding:4px 12px 4px 0;font-family:Arial,sans-serif;font-size:12px;color:#8A8F98;">${esc(
                 k.replace(/([A-Z])/g, ' $1')
               )}</td>
               <td style="padding:4px 0;font-family:Arial,sans-serif;font-size:13px;font-weight:bold;color:#16181D;">${esc(
                 Array.isArray(v) ? v.join(' · ') : v
               )}</td>
             </tr>`
        )
        .join('')
    : '';

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#0E1017;">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#0E1017;padding:28px 12px;">
    <tr><td align="center">
      <table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;">

        <tr><td style="padding:0 0 18px 4px;">
          <span style="font-family:Arial,sans-serif;font-size:13px;font-weight:bold;color:#FFFFFF;letter-spacing:3px;">LASAN MART</span>
        </td></tr>

        <tr><td style="background:#2E6BE8;border-radius:16px 16px 0 0;padding:26px 28px;">
          <span style="font-family:Arial,sans-serif;font-size:11px;font-weight:bold;color:rgba(255,255,255,0.75);letter-spacing:1.5px;text-transform:uppercase;">
            📌&nbsp; Assigned to you
          </span>
          <div style="font-family:Arial,sans-serif;font-size:24px;font-weight:bold;color:#FFFFFF;line-height:30px;margin-top:8px;">
            ${esc(r.title || r.name)}
          </div>
        </td></tr>

        <tr><td style="background:#FFFFFF;padding:26px 28px;">

          ${
            note
              ? `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:20px;">
                   <tr><td style="background:#FFF7ED;border-left:4px solid #FF6B35;padding:14px 16px;border-radius:0 8px 8px 0;">
                     <div style="font-family:Arial,sans-serif;font-size:11px;font-weight:bold;color:#8A8F98;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px;">Note from the team</div>
                     <div style="font-family:Arial,sans-serif;font-size:14px;color:#16181D;line-height:21px;">${esc(note).replace(/\n/g, '<br/>')}</div>
                   </td></tr>
                 </table>`
              : ''
          }

          <div style="font-family:Arial,sans-serif;font-size:11px;font-weight:bold;color:#8A8F98;letter-spacing:1.5px;text-transform:uppercase;padding-bottom:12px;">Customer</div>

          <table cellpadding="0" cellspacing="0" border="0" width="100%">
            <tr>
              <td style="padding:0 12px 8px 0;font-family:Arial,sans-serif;font-size:12px;color:#8A8F98;width:90px;">Name</td>
              <td style="padding:0 0 8px 0;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;color:#16181D;">${esc(r.name)}</td>
            </tr>
            <tr>
              <td style="padding:0 12px 8px 0;font-family:Arial,sans-serif;font-size:12px;color:#8A8F98;">Phone</td>
              <td style="padding:0 0 8px 0;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">
                <a href="tel:+91${esc(r.phone)}" style="color:#16181D;text-decoration:none;">${esc(r.phone)}</a>
              </td>
            </tr>
            ${
              r.email
                ? `<tr>
                     <td style="padding:0 12px 8px 0;font-family:Arial,sans-serif;font-size:12px;color:#8A8F98;">Email</td>
                     <td style="padding:0 0 8px 0;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">
                       <a href="mailto:${esc(r.email)}" style="color:#2E6BE8;text-decoration:none;">${esc(r.email)}</a>
                     </td>
                   </tr>`
                : ''
            }
            ${r.company_name ? `<tr><td style="padding:0 12px 8px 0;font-family:Arial,sans-serif;font-size:12px;color:#8A8F98;">Company</td><td style="padding:0 0 8px 0;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;color:#16181D;">${esc(r.company_name)}</td></tr>` : ''}
            ${r.sector ? `<tr><td style="padding:0 12px 8px 0;font-family:Arial,sans-serif;font-size:12px;color:#8A8F98;">Sector</td><td style="padding:0 0 8px 0;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;color:#16181D;">${esc(r.sector)}</td></tr>` : ''}
            ${r.city ? `<tr><td style="padding:0 12px 8px 0;font-family:Arial,sans-serif;font-size:12px;color:#8A8F98;">City</td><td style="padding:0 0 8px 0;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;color:#16181D;">${esc(r.city)}</td></tr>` : ''}
          </table>

          ${
            r.description
              ? `<div style="background:#F4F5F7;border-radius:10px;padding:16px 18px;margin-top:20px;">
                   <div style="font-family:Arial,sans-serif;font-size:11px;font-weight:bold;color:#8A8F98;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">What they need</div>
                   <div style="font-family:Arial,sans-serif;font-size:15px;color:#16181D;line-height:23px;">${esc(r.description).replace(/\n/g, '<br/>')}</div>
                 </div>`
              : ''
          }

          ${
            detailRows
              ? `<div style="font-family:Arial,sans-serif;font-size:11px;font-weight:bold;color:#8A8F98;letter-spacing:1.5px;text-transform:uppercase;padding:20px 0 10px 0;">Details</div>
                 <table cellpadding="0" cellspacing="0" border="0" width="100%">${detailRows}</table>`
              : ''
          }

          <table cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;">
            <tr><td style="background:#FF6B35;border-radius:10px;">
              <a href="tel:+91${esc(r.phone)}" style="display:inline-block;padding:14px 26px;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;color:#FFFFFF;text-decoration:none;">
                Call ${esc(r.name)}
              </a>
            </td></tr>
          </table>

        </td></tr>

        <tr><td style="background:#16181D;border-radius:0 0 16px 16px;padding:16px 28px;">
          <span style="font-family:'Courier New',monospace;font-size:10px;color:#5C6270;">${esc(r.id)}</span>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;

  const result = await resend.emails.send({
    from: config.resend.from,
    to,
    replyTo: r.email || undefined,
    subject: `📌 Assigned: ${r.title || r.name} (${r.phone})`,
    html,
  });

  if (result.error) {
    throw new Error(result.error.message);
  }

  return result;
}