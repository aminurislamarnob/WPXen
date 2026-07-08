'use strict';

const crypto = require('crypto');
const http = require('http');

// OAuth 2 authorization-code + PKCE over a loopback redirect — the native-app
// flow both Dropbox and Google document. The main process opens the provider's
// consent page in the default browser and catches the redirect on a one-shot
// 127.0.0.1 server on a random port. No client secret is required (PKCE); no
// embedded webview is involved.

// ─── PKCE (pure) ─────────────────────────────────────────────────────────

// 48 random bytes → 64 base64url chars, inside RFC 7636's 43–128 range.
function generateVerifier() {
  return crypto.randomBytes(48).toString('base64url');
}

function challengeFromVerifier(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// ─── Loopback redirect catcher ───────────────────────────────────────────

const LANDING_HTML = `<!doctype html><html><head><title>WPHerd</title></head>
<body style="font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:90vh">
<div style="text-align:center"><h2>WPHerd is connected</h2><p>You can close this tab and return to the app.</p></div>
</body></html>`;

// Starts a one-shot server, opens `buildAuthUrl(...)` in the browser, and
// resolves with the authorization code once the provider redirects back.
function awaitAuthorizationCode({ buildAuthUrl, openUrl, timeoutMs = 5 * 60 * 1000 }) {
  return new Promise((resolve, reject) => {
    const state = crypto.randomBytes(16).toString('hex');
    const server = http.createServer();
    let timer = null;
    const finish = (fn, arg) => {
      clearTimeout(timer);
      server.close();
      fn(arg);
    };

    server.on('request', (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      res
        .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(LANDING_HTML);
      const err = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      if (url.searchParams.get('state') !== state) {
        finish(reject, new Error('OAuth state mismatch — please try connecting again.'));
      } else if (err) {
        finish(reject, new Error(`Authorization was denied (${err}).`));
      } else if (!code) {
        finish(reject, new Error('The provider did not return an authorization code.'));
      } else {
        finish(resolve, code);
      }
    });
    server.on('error', (err) => finish(reject, err));

    server.listen(0, '127.0.0.1', () => {
      const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
      timer = setTimeout(
        () => finish(reject, new Error('Sign-in timed out. Please try again.')),
        timeoutMs
      );
      try {
        openUrl(buildAuthUrl({ redirectUri, state }));
      } catch (err) {
        finish(reject, err);
      }
    });
  });
}

// Full flow: PKCE pair → browser consent → code → token exchange. `authorize`
// builds the provider's consent URL from {redirectUri, state, challenge};
// `tokenUrl`/`tokenParams` describe the exchange endpoint.
async function runPkceFlow({
  authorize,
  tokenUrl,
  clientId,
  extraTokenParams = {},
  openUrl,
}) {
  const verifier = generateVerifier();
  const challenge = challengeFromVerifier(verifier);

  let redirectUri = null;
  const codePromise = awaitAuthorizationCode({
    buildAuthUrl: ({ redirectUri: uri, state }) => {
      redirectUri = uri;
      return authorize({ redirectUri: uri, state, challenge });
    },
    openUrl,
  });
  const code = await codePromise;

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    ...extraTokenParams,
  });
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(
      json.error_description ||
        json.error ||
        `Token exchange failed (HTTP ${res.status}).`
    );
  }
  return json;
}

module.exports = {
  generateVerifier,
  challengeFromVerifier,
  awaitAuthorizationCode,
  runPkceFlow,
};
