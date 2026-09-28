import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, it, expect } from "vitest";
import { createOidcProvider } from "../server/oidc.js";
import { loadRuntime } from "../server/config.js";
import { token } from "../server/sessions.js";

const runtime = loadRuntime({
  PUBLIC_ORIGIN: "https://dashboard.example.com",
  SESSION_SECRET: "test-cookie-secret-32-characters-only",
  OIDC_ISSUER: "https://identity.example.com",
  OIDC_CLIENT_ID: "dashboard",
  OIDC_CLIENT_SECRET: "synthetic-credential",
});
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const jwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: "fixture",
  use: "sig",
  alg: "RS256",
};
function idToken(nonce: string, audience = "dashboard", expiry = 600) {
  const enc = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = enc({ alg: "RS256", kid: "fixture" });
  const body = enc({
    iss: runtime.issuer,
    aud: audience,
    sub: "subject-one",
    iat: now,
    exp: now + expiry,
    nonce,
  });
  return `${head}.${body}.${sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url")}`;
}
async function authority(
  options: {
    wrongNonce?: boolean;
    wrongAudience?: boolean;
    wrongSubject?: boolean;
    expired?: boolean;
  } = {},
) {
  const attempt = {
    state: token(),
    nonce: token(),
    verifier: token(),
    expiresAt: Date.now() + 300000,
  };
  let tokenBody: URLSearchParams | undefined;
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  const provider = await createOidcProvider(runtime, async (input, init) => {
    const url = new URL(input);
    if (url.pathname === "/.well-known/openid-configuration")
      return json({
        issuer: runtime.issuer,
        authorization_endpoint: `${runtime.issuer}/authorize`,
        token_endpoint: `${runtime.issuer}/token`,
        userinfo_endpoint: `${runtime.issuer}/userinfo`,
        jwks_uri: `${runtime.issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_post"],
        code_challenge_methods_supported: ["S256"],
      });
    if (url.pathname === "/jwks") return json({ keys: [jwk] });
    if (url.pathname === "/token") {
      tokenBody = new URLSearchParams(String(init?.body));
      return json({
        access_token: "synthetic-access",
        token_type: "Bearer",
        expires_in: 600,
        id_token: idToken(
          options.wrongNonce ? "wrong" : attempt.nonce,
          options.wrongAudience ? "other-client" : "dashboard",
          options.expired ? -600 : 600,
        ),
      });
    }
    if (url.pathname === "/userinfo")
      return json({
        sub: options.wrongSubject ? "different-user" : "subject-one",
        given_name: "Alex",
        name: "Alex Morgan",
        groups: ["users"],
      });
    throw new Error("Unexpected fixture endpoint");
  });
  const callback = new URL(
    `${runtime.origin}/auth/callback?code=fixture-code&state=${attempt.state}`,
  );
  return { provider, attempt, callback, tokenBody: () => tokenBody };
}
describe("real openid-client code flow", () => {
  it("sends state, nonce and S256 PKCE, validates signed ID token and matching UserInfo", async () => {
    const f = await authority();
    const url = new URL(await f.provider.login(f.attempt));
    expect(url.searchParams.get("state")).toBe(f.attempt.state);
    expect(url.searchParams.get("nonce")).toBe(f.attempt.nonce);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(f.attempt.verifier).digest("base64url"),
    );
    const result = await f.provider.exchange(f.callback, f.attempt);
    expect(result.claims.given_name).toBe("Alex");
    expect(result.claims.groups).toEqual(["users"]);
    expect(f.tokenBody()?.get("code_verifier")).toBe(f.attempt.verifier);
    expect(f.tokenBody()?.get("redirect_uri")).toBe(
      `${runtime.origin}/auth/callback`,
    );
  });
  it.each([
    { wrongNonce: true },
    { wrongAudience: true },
    { wrongSubject: true },
    { expired: true },
  ])("rejects invalid identity response %j", async (options) => {
    const f = await authority(options);
    await expect(f.provider.exchange(f.callback, f.attempt)).rejects.toThrow();
  });
  it("rejects a state mismatch inside the client as well as the HTTP handler", async () => {
    const f = await authority();
    f.callback.searchParams.set("state", "wrong");
    await expect(f.provider.exchange(f.callback, f.attempt)).rejects.toThrow();
  });
});
