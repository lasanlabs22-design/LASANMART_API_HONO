import { pool } from '../db/pool.js';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

type PushMessage = {
  to: string;
  title: string;
  body: string;
  data?: Record<string, any>;
};

/**
 * Sends a push notification through Expo's service.
 *
 * Never throws — a failed push must not break the action that
 * triggered it. Worst case the user sees it next time they open
 * the app, since the notification row is already saved.
 */
export async function sendPush(message: PushMessage): Promise<boolean> {
  if (!message.to?.startsWith('ExponentPushToken')) return false;

  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: message.to,
        title: message.title,
        body: message.body,
        data: message.data || {},
        sound: 'default',
        priority: 'high',
        channelId: 'default',
      }),
    });

    const result = await res.json();
    const status = result?.data?.status;

    // Expo tells us when a token is dead — clear it so we stop trying
    if (status === 'error') {
      const error = result?.data?.details?.error;

      if (error === 'DeviceNotRegistered') {
        await pool
          .query(
            'UPDATE contacts SET push_token = NULL WHERE push_token = $1',
            [message.to]
          )
          .catch(() => {});
      }

      console.log('Push rejected:', error);
      return false;
    }

    return true;
  } catch (err) {
    console.error('Push failed:', err);
    return false;
  }
}

/** Looks up this contact's device and sends to it */
export async function pushToContact(
  contactId: string,
  title: string,
  body: string,
  data?: Record<string, any>
) {
  try {
    const result = await pool.query(
      'SELECT push_token FROM contacts WHERE id = $1',
      [contactId]
    );

    const token = result.rows[0]?.push_token;
    if (!token) return false;

    return await sendPush({ to: token, title, body, data });
  } catch (err) {
    console.error('Could not look up push token:', err);
    return false;
  }
}