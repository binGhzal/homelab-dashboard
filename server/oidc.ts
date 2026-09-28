import * as oidc from "openid-client";
import type { Runtime } from "./config.js";
import type { LoginAttempt } from "./sessions.js";
export interface LoginResult {
  claims: Record<string, unknown>;
  accessToken: string;
  expiresIn: number;
}
export interface IdentityProvider {
  login(attempt: LoginAttempt): Promise<string>;
  exchange(callback: URL, attempt: LoginAttempt): Promise<LoginResult>;
  userinfo(
    accessToken: string,
    subject: string,
  ): Promise<Record<string, unknown>>;
}
export async function createOidcProvider(
  runtime: Runtime,
  fetcher?: oidc.CustomFetch,
): Promise<IdentityProvider> {
  const config = await oidc.discovery(
    new URL(runtime.issuer),
    runtime.clientId,
    runtime.clientSecret,
    undefined,
    {
      timeout: 8,
      ...(fetcher ? { [oidc.customFetch]: fetcher } : {}),
    },
  );
  const redirect = `${runtime.origin}/auth/callback`;
  return {
    async login(attempt) {
      return oidc.buildAuthorizationUrl(config, {
        redirect_uri: redirect,
        scope: "openid profile email",
        response_type: "code",
        state: attempt.state,
        nonce: attempt.nonce,
        code_challenge_method: "S256",
        code_challenge: await oidc.calculatePKCECodeChallenge(attempt.verifier),
      }).href;
    },
    async exchange(callback, attempt) {
      const tokens = await oidc.authorizationCodeGrant(config, callback, {
        pkceCodeVerifier: attempt.verifier,
        expectedState: attempt.state,
        expectedNonce: attempt.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims?.sub || !tokens.access_token)
        throw new Error("Identity response missing required claims");
      // UserInfo is the authority for current group membership, not a stale ID-token snapshot.
      const info = await oidc.fetchUserInfo(
        config,
        tokens.access_token,
        claims.sub,
      );
      return {
        claims: info,
        accessToken: tokens.access_token,
        expiresIn: Math.min(
          tokens.expires_in ?? 300,
          runtime.sessionTtlSeconds,
        ),
      };
    },
    async userinfo(accessToken, subject) {
      return await oidc.fetchUserInfo(config, accessToken, subject);
    },
  };
}
