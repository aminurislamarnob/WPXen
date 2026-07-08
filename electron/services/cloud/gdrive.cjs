'use strict';

const fs = require('fs');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const oauth = require('./oauth.cjs');
const tokens = require('./tokens.cjs');

// Google Drive provider. Scope is drive.file only — WPHerd can see and touch
// nothing but the files it created itself, all kept inside a "WPHerd" folder.
// PKCE + loopback like Dropbox. NOTE: shipping this requires a Google Cloud
// project with a verified OAuth consent screen (maintainer task — see the
// development plan); until the client id below is baked in, the provider
// reports itself as not configured and the UI explains why.

const ID = 'gdrive';
const NAME = 'Google Drive';

const CLIENT_ID = process.env.WPHERD_GDRIVE_CLIENT_ID || '';
// Google "Desktop app" OAuth clients are issued a client_secret that is not
// actually confidential (Google's own docs say so) and the token endpoint
// requires it even with PKCE.
const CLIENT_SECRET = process.env.WPHERD_GDRIVE_CLIENT_SECRET || '';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const SCOPE = 'https://www.googleapis.com/auth/drive.file email';

const FOLDER_NAME = 'WPHerd';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
// Resumable-upload chunks must be multiples of 256 KiB; 8 MiB is.
const CHUNK_SIZE = 8 * 1024 * 1024;

function isConfigured() {
  return CLIENT_ID.length > 0;
}

function driveError(json, status) {
  return new Error(
    (json &&
      json.error &&
      (json.error.message || json.error_description || json.error)) ||
      `Google Drive request failed (HTTP ${status}).`
  );
}

// ─── Tokens ──────────────────────────────────────────────────────────────

function withExpiry(t, previous = {}) {
  return {
    ...previous,
    ...t,
    // Google only returns refresh_token on first consent — keep the original.
    refresh_token: t.refresh_token || previous.refresh_token,
    expires_at: t.expires_in ? Date.now() + t.expires_in * 1000 : null,
  };
}

async function refreshAccessToken(store, current, fetchImpl = fetch) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: current.refresh_token,
    client_id: CLIENT_ID,
    ...(CLIENT_SECRET ? { client_secret: CLIENT_SECRET } : {}),
  });
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error('Your Google Drive session has expired — please reconnect.');
  }
  const merged = withExpiry(json, current);
  tokens.saveTokens(store, ID, merged);
  return merged.access_token;
}

async function getAccessToken(store, fetchImpl = fetch) {
  const t = tokens.loadTokens(store, ID);
  if (!t || !t.refresh_token) throw new Error('Google Drive is not connected.');
  if (t.expires_at && Date.now() < t.expires_at - 60 * 1000) return t.access_token;
  return refreshAccessToken(store, t, fetchImpl);
}

async function api(
  store,
  method,
  url,
  { body, headers = {}, retried = false, fetchImpl = fetch } = {}
) {
  const token = await getAccessToken(store, fetchImpl);
  const res = await fetchImpl(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...headers },
    body,
  });
  if (res.status === 401 && !retried) {
    await refreshAccessToken(store, tokens.loadTokens(store, ID), fetchImpl);
    return api(store, method, url, { body, headers, retried: true, fetchImpl });
  }
  return res;
}

async function apiJson(store, method, url, opts = {}) {
  const res = await api(store, method, url, opts);
  const json = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw driveError(json, res.status);
  return json;
}

// ─── Folder ──────────────────────────────────────────────────────────────

// Finds (or creates) the WPHerd folder and caches its id. drive.file scope
// only surfaces files this app created, so the query can't collide with a
// user's own folder of the same name.
async function ensureFolder(store) {
  const cached = store.get(`settings.cloud.${ID}.folderId`, null);
  if (cached) {
    try {
      const meta = await apiJson(
        store,
        'GET',
        `${API}/files/${cached}?fields=id,trashed`
      );
      if (!meta.trashed) return cached;
    } catch {
      // fall through and recreate
    }
  }
  const q = encodeURIComponent(
    `name='${FOLDER_NAME}' and mimeType='${FOLDER_MIME}' and trashed=false`
  );
  const found = await apiJson(store, 'GET', `${API}/files?q=${q}&fields=files(id)`);
  let folderId = found.files?.[0]?.id;
  if (!folderId) {
    const created = await apiJson(store, 'POST', `${API}/files?fields=id`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME }),
    });
    folderId = created.id;
  }
  store.set(`settings.cloud.${ID}.folderId`, folderId);
  return folderId;
}

async function findFileByName(store, folderId, name) {
  const q = encodeURIComponent(
    `name='${name.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed=false`
  );
  const res = await apiJson(
    store,
    'GET',
    `${API}/files?q=${q}&fields=files(id,name,size,modifiedTime)`
  );
  return res.files?.[0] || null;
}

// ─── Provider interface ──────────────────────────────────────────────────

async function connect(store, { openUrl }) {
  if (!isConfigured()) {
    throw new Error(
      'Google Drive integration is not configured in this build of WPHerd.'
    );
  }
  const tokenResponse = await oauth.runPkceFlow({
    authorize: ({ redirectUri, state, challenge }) =>
      `${AUTH_URL}?${new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: 'code',
        redirect_uri: redirectUri,
        state,
        scope: SCOPE,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        access_type: 'offline',
        prompt: 'consent',
      })}`,
    tokenUrl: TOKEN_URL,
    clientId: CLIENT_ID,
    extraTokenParams: CLIENT_SECRET ? { client_secret: CLIENT_SECRET } : {},
    openUrl,
  });
  tokens.saveTokens(store, ID, withExpiry(tokenResponse));

  let email = '';
  try {
    const res = await api(store, 'GET', 'https://www.googleapis.com/oauth2/v2/userinfo');
    email = (await res.json())?.email || '';
  } catch {}
  const info = { email, name: '', connectedAt: new Date().toISOString() };
  store.set(`settings.cloud.${ID}.account`, info);
  return info;
}

function disconnect(store) {
  tokens.clearTokens(store, ID);
  store.delete(`settings.cloud.${ID}.account`);
  store.delete(`settings.cloud.${ID}.folderId`);
}

function isConnected(store) {
  return tokens.hasTokens(store, ID);
}

function getAccount(store) {
  return store.get(`settings.cloud.${ID}.account`, null);
}

// Resumable upload: one metadata POST for the session URI, then sequential
// Content-Range chunk PUTs (Google replies 308 until the last one).
async function upload(
  store,
  localPath,
  remoteName,
  onProgress,
  { fetchImpl = fetch } = {}
) {
  const progress = onProgress || (() => {});
  const { size } = fs.statSync(localPath);
  const folderId = await ensureFolder(store);

  // Overwrite semantics: drop any previous archive with the same name.
  const existing = await findFileByName(store, folderId, remoteName);
  if (existing) {
    await api(store, 'DELETE', `${API}/files/${existing.id}`);
  }

  const initRes = await api(
    store,
    'POST',
    `${UPLOAD_API}/files?uploadType=resumable&fields=id`,
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': 'application/zip',
        'X-Upload-Content-Length': String(size),
      },
      body: JSON.stringify({ name: remoteName, parents: [folderId] }),
      fetchImpl,
    }
  );
  if (!initRes.ok)
    throw driveError(await initRes.json().catch(() => ({})), initRes.status);
  const sessionUri = initRes.headers.get('location');
  if (!sessionUri) throw new Error('Google Drive did not return an upload session.');

  if (size === 0) {
    const res = await fetchImpl(sessionUri, {
      method: 'PUT',
      headers: { 'Content-Range': 'bytes */0', 'Content-Length': '0' },
    });
    if (!res.ok) throw driveError(await res.json().catch(() => ({})), res.status);
    progress({ transferred: 0, total: 0 });
    return;
  }

  const fd = fs.openSync(localPath, 'r');
  try {
    for (let offset = 0; offset < size; offset += CHUNK_SIZE) {
      const length = Math.min(CHUNK_SIZE, size - offset);
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, offset);
      const res = await fetchImpl(sessionUri, {
        method: 'PUT',
        headers: {
          'Content-Range': `bytes ${offset}-${offset + length - 1}/${size}`,
          'Content-Length': String(length),
        },
        body: buf,
      });
      // 308 = chunk accepted, keep going; 2xx = upload complete.
      if (res.status !== 308 && !res.ok) {
        throw driveError(await res.json().catch(() => ({})), res.status);
      }
      progress({ transferred: offset + length, total: size });
    }
  } finally {
    fs.closeSync(fd);
  }
}

async function list(store, prefix = '') {
  const folderId = await ensureFolder(store);
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const files = [];
  let pageToken = '';
  do {
    const url = `${API}/files?q=${q}&fields=nextPageToken,files(id,name,size,modifiedTime)&pageSize=100${
      pageToken ? `&pageToken=${pageToken}` : ''
    }`;
    const res = await apiJson(store, 'GET', url);
    files.push(...(res.files || []));
    pageToken = res.nextPageToken || '';
  } while (pageToken);
  return files
    .filter((f) => f.name.startsWith(prefix))
    .map((f) => ({
      name: f.name,
      sizeBytes: Number(f.size || 0),
      modifiedAt: f.modifiedTime || null,
    }));
}

async function download(store, remoteName, localPath) {
  const folderId = await ensureFolder(store);
  const file = await findFileByName(store, folderId, remoteName);
  if (!file) throw new Error('That file no longer exists in Google Drive.');
  const res = await api(store, 'GET', `${API}/files/${file.id}?alt=media`);
  if (!res.ok) throw driveError(await res.json().catch(() => ({})), res.status);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(localPath));
}

async function remove(store, remoteName) {
  const folderId = await ensureFolder(store);
  const file = await findFileByName(store, folderId, remoteName);
  if (!file) return;
  const res = await api(store, 'DELETE', `${API}/files/${file.id}`);
  if (!res.ok && res.status !== 404) {
    throw driveError(await res.json().catch(() => ({})), res.status);
  }
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
  CHUNK_SIZE,
};
