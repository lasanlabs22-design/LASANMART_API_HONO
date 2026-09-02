import { createMiddleware } from 'hono/factory';
import { verifiedPhoneFrom } from '../lib/firebase.js';

/**
 * Guards anything that reads or writes a person's own data.
 *
 * Puts the verified phone number on the context, so routes read
 * `c.get('phone')` instead of trusting a query parameter.
 */
export const requirePhone = createMiddleware<{
  Variables: { phone: string };
}>(async (c, next) => {
  const phone = await verifiedPhoneFrom(c.req.header('Authorization'));

  if (!phone) {
    return c.json(
      { error: 'Please verify your phone number to continue.' },
      401
    );
  }

  c.set('phone', phone);
  await next();
});
