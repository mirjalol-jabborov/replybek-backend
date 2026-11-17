import crypto from "crypto";

/**
 * "Continue with Google" (OAuth 2.0 authorization code flow with PKCE). Off unless GOOGLE_CLIENT_ID and
 * GOOGLE_CLIENT_SECRET are set. Google sends the browser back to GOOGLE_REDIRECT_URI, by default
 * {APP_ORIGIN}/api/auth/google/callback, so the session cookie lands on the dashboard's origin like a
 * normal sign-in. That exact URI must be listed in the Google Cloud OAuth client.
 */
export const googleEnabled = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
export const redirectUri = () => process.env.GOOGLE_REDIRECT_URI || `${process.env.APP_ORIGIN || "http://localhost:5173"}/api/auth/google/callback`;
const AUTH_URL = () => process.env.GOOGLE_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = () => process.env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token";

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** The Google sign-in URL, plus the state and PKCE verifier to keep in a short-lived cookie. */
export function authorizationUrl() {
  const state = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const url = new URL(AUTH_URL());
  url.search = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return { url: url.href, state, verifier };
}

/**
 * Exchanges the code for Google's ID token and returns who signed in. The token comes straight from
 * Google's token endpoint over TLS with our client secret, so its signature needn't be re-checked
 * (Google's guidance); its audience, issuer, expiry and email verification still are.
 */
export async function exchangeCode(code, verifier) {
  const res = await fetch(TOKEN_URL(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, code_verifier: verifier, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri(), grant_type: "authorization_code" }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id_token) throw new Error(`Google token exchange failed (${res.status}): ${data.error || "no id_token"}`);
  const claims = JSON.parse(Buffer.from(String(data.id_token).split(".")[1] || "", "base64url").toString("utf8"));
  if (claims.aud !== process.env.GOOGLE_CLIENT_ID) throw new Error("Google token is for another app.");
  if (!["accounts.google.com", "https://accounts.google.com"].includes(claims.iss)) throw new Error("Google token has an unexpected issuer.");
  if (!claims.exp || claims.exp * 1000 < Date.now()) throw new Error("Google token has expired.");
  return { sub: String(claims.sub), email: claims.email, emailVerified: claims.email_verified === true || claims.email_verified === "true", name: claims.name || claims.given_name || "", givenName: claims.given_name || "" };
}
