import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import { pushToContact } from './push.js';

/** Customer-facing wording for each status */
const STATUS_MESSAGES: Record<string, { title: string; body: string }> = {
  contacted: {
    title: 'We got your request',
    body: 'Our team has picked it up and will be in touch shortly.',
  },
  in_progress: {
    title: 'Work has started',
    body: 'Our team is now working on your request.',
  },
  closed: {
    title: 'Request completed',
    body: 'This request has been marked complete. Thanks for choosing Lasan Mart.',
  },
  new: {
    title: 'Request reopened',
    body: 'Our team has reopened this request.',
  },
};

/**
 * Write a notification the customer will see in the app.
 * Never throws — a failed notification must not break the action
 * that triggered it.
 */
export async function createNotification(
  contactId: string,
  opts: {
    requestId?: string | null;
    type?: string;
    title: string;
    body: string;
  },
  client?: PoolClient
) {
  const db = client || pool;

  try {
    await db.query(
      `INSERT INTO notifications (contact_id, request_id, type, title, body)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        contactId,
        opts.requestId || null,
        opts.type || 'status',
        opts.title,
        opts.body,
      ]
    );
  } catch (err) {
    console.error('Could not create notification:', err);
  }
}

/**
 * Called when the team changes a status in the console.
 * Builds the wording from the new status and the request's title.
 */
export async function notifyStatusChange(
  contactId: string,
  requestId: string,
  newStatus: string,
  requestTitle: string | null
) {
  const message = STATUS_MESSAGES[newStatus];
  if (!message) return;

  const subject = requestTitle ? `"${requestTitle}"` : 'your request';

  const body = message.body
    .replace('your request', subject)
    .replace('This request', subject);

  await createNotification(contactId, {
    requestId,
    type: 'status',
    title: message.title,
    body,
  });

  // Buzz their phone — the in-app notification is already saved,
  // so a failure here just means they see it next time they open the app
  await pushToContact(contactId, message.title, body, {
    type: 'status',
    requestId,
  });
}

/**
 * A welcome message on someone's very first request, so the
 * notifications screen isn't empty the first time they open it.
 */
export async function notifyFirstRequest(
  contactId: string,
  requestId: string,
  client?: PoolClient
) {
  await createNotification(
    contactId,
    {
      requestId,
      type: 'welcome',
      title: 'Welcome to Lasan Mart',
      body: 'Your first request is in. Our team reviews every request and usually responds within one working day.',
    },
    client
  );
}
