import { InfisicalSDK } from "@infisical/sdk";

const DEFAULT_SITE_URL = "https://hush.gitnasr.com";

function resolveEnvironment(): string {
  const explicit = process.env.INFISICAL_ENVIRONMENT?.trim();
  if (explicit) {
    return explicit;
  }
  return process.env.NODE_ENV === "production" ? "prod" : "dev";
}

/**
 * Fetches secrets from Infisical (universal-auth machine identity) and injects
 * them into process.env at startup. No-op when the INFISICAL_* bootstrap creds
 * are absent, so local dev falls back to `.env`. Existing env vars win, so the
 * bootstrap creds and NODE_ENV are never clobbered.
 */
export async function loadInfisicalSecrets(): Promise<void> {
  const siteUrl = process.env.INFISICAL_SITE_URL?.trim() || DEFAULT_SITE_URL;
  const projectId = process.env.INFISICAL_PROJECT_ID?.trim();
  const clientId = process.env.INFISICAL_CLIENT_ID?.trim();
  const clientSecret = process.env.INFISICAL_CLIENT_SECRET?.trim();

  if (!projectId || !clientId || !clientSecret) {
    return;
  }

  const environment = resolveEnvironment();
  const client = new InfisicalSDK({ siteUrl });
  await client.auth().universalAuth.login({ clientId, clientSecret });

  const { secrets } = await client.secrets().listSecrets({
    environment,
    projectId,
    secretPath: process.env.INFISICAL_SECRET_PATH?.trim() || "/",
    expandSecretReferences: true,
    viewSecretValue: true,
  });

  for (const secret of secrets) {
    if (process.env[secret.secretKey] === undefined) {
      process.env[secret.secretKey] = secret.secretValue;
    }
  }
}
