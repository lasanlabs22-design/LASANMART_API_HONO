import { Resend } from 'resend';
import { config } from '../config.js';

const resend = new Resend(config.resend.apiKey);

type ReelReport = {
  reelId: string;
  videoUrl: string;
  caption: string | null;
  username: string;
  reason: string;
  details: string | null;
  reportCount: number;
  autoHidden: boolean;
};

const escape = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * Tells the team a Vibes reel was reported, so someone looks at it
 * the same day. Throws on failure — the caller decides what that means.
 */
export async function sendReelReport(data: ReelReport) {
  const rows: [string, string][] = [
    ['Reel', data.reelId],
    ['Posted by', data.username],
    ['Caption', data.caption || '—'],
    ['Reason', data.reason],
    ['Details', data.details || '—'],
    ['Reports so far', String(data.reportCount)],
  ];

  const html = `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;color:#1A1A1A;">
  <h2 style="margin:0 0 6px;">A Vibes reel was reported</h2>
  <p style="margin:0 0 16px;color:#5C6270;">
    ${
      data.autoHidden
        ? 'It has now been reported by enough people that it was <b>hidden automatically</b>. Review it in the admin console and set it back to live if it is fine.'
        : 'It is still live. Review it in the admin console and hide it if it breaks the rules.'
    }
  </p>
  <table style="border-collapse:collapse;width:100%;font-size:14px;">
    ${rows
      .map(
        ([k, v]) =>
          `<tr><td style="padding:6px 10px 6px 0;color:#5C6270;vertical-align:top;white-space:nowrap;">${k}</td><td style="padding:6px 0;">${escape(v)}</td></tr>`
      )
      .join('')}
  </table>
  <p style="margin:18px 0 0;"><a href="${escape(data.videoUrl)}">Watch the video</a></p>
</div>`;

  const result = await resend.emails.send({
    from: config.resend.from,
    to: config.resend.to,
    subject: `${data.autoHidden ? 'Hidden after reports' : 'Reported'}: Vibes reel by ${data.username}`,
    html,
  });

  if (result.error) {
    throw new Error(result.error.message);
  }
}
