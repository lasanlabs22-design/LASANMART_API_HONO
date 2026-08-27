import 'dotenv/config';

/**
 * Every setting the app needs, read from .env and checked once at startup.
 * If something is missing we fail immediately with a clear message,
 * rather than crashing later with a confusing one.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing environment variable: ${name}\n` +
      `Add it to your .env file (or Railway's Variables tab).`
    );
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT) || 3000,

  resend: {
    apiKey: required('RESEND_API_KEY'),
    from: process.env.MAIL_FROM || 'onboarding@resend.dev',
    to: required('MAIL_TO'),
  },
    adminPassword: required('ADMIN_PASSWORD'),
    databaseUrl: (() => {
    const url = process.env.DATABASE_URL || '';
    if (url.includes('railway.internal')) {
      throw new Error(
        'DATABASE_URL is using the internal Railway address (railway.internal), ' +
        'which only works when running ON Railway. For local development, use the ' +
        'PUBLIC connection string instead — find it under the Postgres service\'s ' +
        '"Connect" tab in Railway.'
      );
    }
    return url;
  })(),
};