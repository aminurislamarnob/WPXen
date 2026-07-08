'use strict';

const fs = require('fs');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const oauth = require('./oauth.cjs');
const tokens = require('./tokens.cjs');

// Dropbox provider. The OAuth app uses App Folder access, so every path here
// is relative to /Apps/WPHerd/ in the user's Dropbox — WPHerd can't see
// anything else. PKCE + offline access, no client secret.

const ID = 'dropbox';
const NAME = 'Dropbox';

// Registering the Dropbox app (App Folder permission, name "WPHerd") is a
// maintainer task; bake the app key here once it exists. The env override
// lets development builds test the flow without a source change.
const CLIENT_ID = process.env.WPHERD_DROPBOX_CLIENT_ID || '';

const AUTH_URL = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const API = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';

const CHUNK_SIZE = 8 * 1024 * 1024;
// Dropbox's single-call cap is 150 MB; switch to upload sessions well below it.
const SIMPLE_UPLOAD_LIMIT = 32 * 1024 * 1024;

// Splits `totalSize` bytes into upload-session chunks. Pure — covered by
// vitest (the chunk sequencing is the part that must never drift).
function planChunks(totalSize, chunkSize = CHUNK_SIZE) {
  if (totalSize <= 0) return [{ offset: 0, length: 0, last: true }];
  const chunks = [];
  for (let offset = 0; offset < totalSize; offset += chunkSize) {
    const length = Math.min(chunkSize, totalSize - offset);
    chunks.push({ offset, length, last: offset + length >= totalSize });
  }
  return chunks;
}

function isConfigured() {
  return CLIENT_ID.length > 0;
}

function dropboxError(json, status) {
  return new Error(
    (json && (json.error_summary || json.error_description || json.error)) ||
      `Dropbox request failed (HTTP ${status}).`
  );
}

// ─── Tokens ──────────────────────────────────────────────────────────────

function withExpiry(t, previous = {}) {
  return {
    ...previous,
    ...t,
    // Dropbox refresh responses omit the refresh token — keep the original.
    refresh_token: t.refresh_token || previous.refresh_token,
    expires_at: t.expires_in ? Date.now() + t.expires_in * 1000 : null,
  };
}

async function refreshAccessToken(store, current, fetchImpl = fetch) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: current.refresh_token,
    client_id: CLIENT_ID,
  });
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error('Your Dropbox session has expired — please reconnect.');
  }
  const merged = withExpiry(json, current);
  tokens.saveTokens(store, ID, merged);
  return merged.access_token;
}

async function getAccessToken(store, fetchImpl = fetch) {
  const t = tokens.loadTokens(store, ID);
  if (!t || !t.refresh_token) throw new Error('Dropbox is not connected.');
  if (t.expires_at && Date.now() < t.expires_at - 60 * 1000) return t.access_token;
  return refreshAccessToken(store, t, fetchImpl);
}

// ─── API helpers ─────────────────────────────────────────────────────────

// JSON-RPC call against api.dropboxapi.com; retries once through a token
// refresh on 401.
async function rpc(store, endpoint, body, { fetchImpl = fetch, retried = false } = {}) {
  const token = await getAccessToken(store, fetchImpl);
  const res = await fetchImpl(`${API}/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? null),
  });
  if (res.status === 401 && !retried) {
    await refreshAccessToken(store, tokens.loadTokens(store, ID), fetchImpl);
    return rpc(store, endpoint, body, { fetchImpl, retried: true });
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw dropboxError(json, res.status);
  return json;
}

// Content-endpoint call (upload/download style): args ride in the
// Dropbox-API-Arg header, the body is raw bytes.
async function contentCall(store, endpoint, args, body, { fetchImpl = fetch } = {}) {
  const token = await getAccessToken(store, fetchImpl);
  const res = await fetchImpl(`${CONTENT}/${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Dropbox-API-Arg': JSON.stringify(args),
      'Content-Type': 'application/octet-stream',
    },
    body,
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw dropboxError(json, res.status);
  }
  return res;
}

// ─── Provider interface ──────────────────────────────────────────────────

async function connect(store, { openUrl }) {
  if (!isConfigured()) {
    throw new Error('Dropbox integration is not configured in this build of WPHerd.');
  }
  const tokenResponse = await oauth.runPkceFlow({
    authorize: ({ redirectUri, state, challenge }) =>
      `${AUTH_URL}?${new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: 'code',
        redirect_uri: redirectUri,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        token_access_type: 'offline',
      })}`,
    tokenUrl: TOKEN_URL,
    clientId: CLIENT_ID,
    openUrl,
  });
  tokens.saveTokens(store, ID, withExpiry(tokenResponse));

  const account = await rpc(store, 'users/get_current_account', null);
  const info = {
    email: account?.email || '',
    name: account?.name?.display_name || '',
    connectedAt: new Date().toISOString(),
  };
  store.set(`settings.cloud.${ID}.account`, info);
  return info;
}

function disconnect(store) {
  tokens.clearTokens(store, ID);
  store.delete(`settings.cloud.${ID}.account`);
}

function isConnected(store) {
  return tokens.hasTokens(store, ID);
}

function getAccount(store) {
  return store.get(`settings.cloud.${ID}.account`, null);
}

async function upload(
  store,
  localPath,
  remoteName,
  onProgress,
  { fetchImpl = fetch } = {}
) {
  const progress = onProgress || (() => {});
  const { size } = fs.statSync(localPath);
  const remotePath = `/${remoteName}`;

  if (size <= SIMPLE_UPLOAD_LIMIT) {
    progress({ transferred: 0, total: size });
    await contentCall(
      store,
      'files/upload',
      { path: remotePath, mode: 'overwrite', mute: true },
      fs.readFileSync(localPath),
      { fetchImpl }
    );
    progress({ transferred: size, total: size });
    return;
  }

  // Chunked upload session for large archives.
  const fd = fs.openSync(localPath, 'r');
  try {
    const startRes = await contentCall(
      store,
      'files/upload_session/start',
      { close: false },
      Buffer.alloc(0),
      { fetchImpl }
    );
    const { session_id: sessionId } = await startRes.json();

    for (const chunk of planChunks(size)) {
      const buf = Buffer.alloc(chunk.length);
      fs.readSync(fd, buf, 0, chunk.length, chunk.offset);
      await contentCall(
        store,
        'files/upload_session/append_v2',
        { cursor: { session_id: sessionId, offset: chunk.offset }, close: false },
        buf,
        { fetchImpl }
      );
      progress({ transferred: chunk.offset + chunk.length, total: size });
    }

    await contentCall(
      store,
      'files/upload_session/finish',
      {
        cursor: { session_id: sessionId, offset: size },
        commit: { path: remotePath, mode: 'overwrite', mute: true },
      },
      Buffer.alloc(0),
      { fetchImpl }
    );
  } finally {
    fs.closeSync(fd);
  }
}

// Lists files in the app folder, optionally filtered by name prefix.
async function list(store, prefix = '') {
  const entries = [];
  let result = await rpc(store, 'files/list_folder', { path: '', recursive: false });
  for (;;) {
    entries.push(...(result.entries || []));
    if (!result.has_more) break;
    result = await rpc(store, 'files/list_folder/continue', { cursor: result.cursor });
  }
  return entries
    .filter((e) => e['.tag'] === 'file' && e.name.startsWith(prefix))
    .map((e) => ({
      name: e.name,
      sizeBytes: e.size || 0,
      modifiedAt: e.server_modified || null,
    }));
}

async function download(store, remoteName, localPath) {
  const res = await contentCall(
    store,
    'files/download',
    { path: `/${remoteName}` },
    undefined
  );
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(localPath));
}

async function remove(store, remoteName) {
  await rpc(store, 'files/delete_v2', { path: `/${remoteName}` });
}

module.exports = {
  id: ID,
  name: NAME,
  isConfigured,
  isConnected,
  getAccount,
  connect,
  disconnect,
  upload,
  list,
  download,
  remove,
  // exposed for tests
  planChunks,
  CHUNK_SIZE,
  SIMPLE_UPLOAD_LIMIT,
};
