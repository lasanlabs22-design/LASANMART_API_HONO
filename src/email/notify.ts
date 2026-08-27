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
  descriptionLabel?: string | null;
  details?: Record<string, any> | null;
};

/** Each request type gets its own colour and icon so the inbox is scannable */
const TYPE_META: Record<
  string,
  { label: string; accent: string; dark: string; emoji: string }
> = {
  service: {
    label: 'Service Request',
    accent: '#FF6B35',
    dark: '#C2410C',
    emoji: '📣',
  },
  custom: {
    label: 'Custom Requirement',
    accent: '#7B2FF7',
    dark: '#4C1D95',
    emoji: '🛠️',
  },
  plan: {
    label: 'Plan Enquiry',
    accent: '#12B3A0',
    dark: '#0B6E63',
    emoji: '💼',
  },
  influencer: {
    label: 'Influencer Selection',
    accent: '#C13584',
    dark: '#831843',
    emoji: '⭐',
  },
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
    return esc(value.join(' · '));
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

/** A label/value row in the contact block */
function infoRow(label: string, value: string, accent: string) {
  return `
    <tr>
      <td style="padding:0 0 14px 0;width:96px;vertical-align:top;">
        <span style="font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:bold;color:#8A8F98;letter-spacing:0.6px;text-transform:uppercase;">
          ${esc(label)}
        </span>
      </td>
      <td style="padding:0 0 14px 0;vertical-align:top;">
        <span style="font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#16181D;">
          ${value}
        </span>
      </td>
    </tr>`;
}

export async function sendRequestNotification(data: RequestNotification) {
  const meta = TYPE_META[data.type] || {
    label: data.type,
    accent: '#FF6B35',
    dark: '#C2410C',
    emoji: '📩',
  };

  const stamp = new Date().toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  /* ---------- Contact rows ---------- */
  const rows = [
    infoRow('Name', esc(data.name), meta.accent),
    infoRow(
      'Phone',
      `<a href="tel:+91${esc(data.phone)}" style="color:#16181D;text-decoration:none;">${esc(data.phone)}</a>`,
      meta.accent
    ),
    data.email
      ? infoRow(
          'Email',
          `<a href="mailto:${esc(data.email)}" style="color:${meta.accent};text-decoration:none;">${esc(data.email)}</a>`,
          meta.accent
        )
      : '',
    data.companyName ? infoRow('Company', esc(data.companyName), meta.accent) : '',
    data.sector ? infoRow('Sector', esc(data.sector), meta.accent) : '',
    data.city ? infoRow('City', esc(data.city), meta.accent) : '',
  ].join('');

  /* ---------- Detail chips ---------- */
  const detailChips = data.details
    ? Object.entries(data.details)
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(
          ([key, value]) => `
            <tr>
              <td style="padding:0 0 8px 0;">
                <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F4F5F7;border-radius:8px;">
                  <tr>
                    <td style="padding:11px 14px;">
                      <span style="font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:bold;color:#8A8F98;letter-spacing:0.5px;text-transform:uppercase;">
                        ${labelKey(key)}
                      </span>
                      <br/>
                      <span style="font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;color:#16181D;line-height:20px;">
                        ${renderValue(value)}
                      </span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>`
        )
        .join('')
    : '';

  /* ---------- The email ---------- */
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#0E1017;">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#0E1017;padding:28px 12px;">
    <tr>
      <td align="center">

        <table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;">

          <!-- Brand bar -->
          <tr>
            <td style="padding:0 0 18px 4px;">
              <span style="font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;color:#FFFFFF;letter-spacing:3px;">
                LASAN MART
              </span>
              <span style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#5C6270;letter-spacing:1px;">
                &nbsp;&nbsp;POST · FIND · GROW
              </span>
            </td>
          </tr>

          <!-- Header block -->
          <tr>
            <td style="background:${meta.accent};border-radius:16px 16px 0 0;padding:26px 28px;">
              <table cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td>
                    <span style="font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:bold;color:rgba(255,255,255,0.75);letter-spacing:1.5px;text-transform:uppercase;">
                      ${meta.emoji}&nbsp; New ${esc(meta.label)}
                    </span>
                    <div style="font-family:Arial,Helvetica,sans-serif;font-size:26px;font-weight:bold;color:#FFFFFF;line-height:32px;margin-top:8px;letter-spacing:-0.5px;">
                      ${data.title ? esc(data.title) : esc(data.name)}
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Accent underline -->
          <tr>
            <td style="background:${meta.dark};height:5px;line-height:5px;font-size:0;">&nbsp;</td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background:#FFFFFF;padding:26px 28px 8px 28px;">

              <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:bold;color:#8A8F98;letter-spacing:1.5px;text-transform:uppercase;padding-bottom:16px;">
                Contact
              </div>

              <table cellpadding="0" cellspacing="0" border="0" width="100%">
                ${rows}
              </table>

              ${
                data.description
                  ? `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:6px 0 20px 0;">
                       <tr>
                         <td style="background:#F4F5F7;border-left:4px solid ${meta.accent};border-radius:0 10px 10px 0;padding:16px 18px;">
                           <div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:bold;color:#8A8F98;letter-spacing:1.2px;text-transform:uppercase;margin-bottom:8px;">
                                                         ${esc(data.descriptionLabel || 'What they need')}
                           </div>
                           <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#16181D;line-height:23px;">
                             ${esc(data.description).replace(/\n/g, '<br/>')}
                           </div>
                         </td>
                       </tr>
                     </table>`
                  : ''
              }

              ${
                detailChips
                  ? `<div style="font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:bold;color:#8A8F98;letter-spacing:1.5px;text-transform:uppercase;padding:6px 0 14px 0;">
                       Details
                     </div>
                     <table cellpadding="0" cellspacing="0" border="0" width="100%">
                       ${detailChips}
                     </table>`
                  : ''
              }

            </td>
          </tr>

          <!-- Action bar -->
          <tr>
            <td style="background:#FFFFFF;padding:10px 28px 26px 28px;">
              <table cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="background:${meta.accent};border-radius:10px;">
                    <a href="tel:+91${esc(data.phone)}"
                       style="display:inline-block;padding:14px 26px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;color:#FFFFFF;text-decoration:none;">
                      Call ${esc(data.name)}
                    </a>
                  </td>
                  ${
                    data.email
                      ? `<td style="width:10px;">&nbsp;</td>
                         <td style="border:2px solid #E4E6EA;border-radius:10px;">
                           <a href="mailto:${esc(data.email)}"
                              style="display:inline-block;padding:12px 24px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;color:#16181D;text-decoration:none;">
                             Reply by Email
                           </a>
                         </td>`
                      : ''
                  }
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#16181D;border-radius:0 0 16px 16px;padding:18px 28px;">
              <table cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td>
                    <span style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#8A8F98;">
                      ${stamp}
                    </span>
                  </td>
                  <td align="right">
                    <span style="font-family:'Courier New',monospace;font-size:10px;color:#5C6270;">
                      ${esc(data.requestId)}
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:16px 4px 0 4px;">
              <span style="font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#5C6270;">
                Sent automatically from the Lasan Mart app.
              </span>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const result = await resend.emails.send({
    from: config.resend.from,
    to: config.resend.to,
    replyTo: data.email || undefined,
    subject: `${meta.emoji} ${meta.label} — ${data.name} (${data.phone})`,
    html,
  });

  if (result.error) {
    throw new Error(result.error.message);
  }

  return result;
}