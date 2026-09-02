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

  cloudinary: {
    cloudName: required('CLOUDINARY_CLOUD_NAME'),
    apiKey: required('CLOUDINARY_API_KEY'),
    // Only used server-side, to delete files from Cloudinary
    apiSecret: required('CLOUDINARY_API_SECRET'),
    uploadPreset: process.env.CLOUDINARY_UPLOAD_PRESET || 'lasan_reels',
  },
  firebase: {
    projectId: required('FIREBASE_PROJECT_ID'),
    clientEmail: required('FIREBASE_CLIENT_EMAIL'),
    // Railway may store this with real newlines or with literal \n,
    // depending on how it was pasted — handle both
    privateKey: required('FIREBASE_PRIVATE_KEY')
      .replace(/\\n/g, '\n')
      .replace(/^["']|["']$/g, ''),
  },

  adminPassword: required('ADMIN_PASSWORD'),

  databaseUrl: (() => {
    const url = process.env.DATABASE_URL || '';
    const isProduction = process.env.NODE_ENV === 'production';

    if (!url) {
      throw new Error('Missing environment variable: DATABASE_URL');
    }

    // The internal address only resolves when running on Railway itself.
    // Locally you need the public connection string instead.
    if (!isProduction && url.includes('railway.internal')) {
      throw new Error(
        'DATABASE_URL is using the internal Railway address (railway.internal), ' +
          'which only works when running ON Railway. For local development, use the ' +
          "PUBLIC connection string instead — find it under the Postgres service's " +
          '"Connect" tab in Railway.'
      );
    }

    return url;
  })(),
};
