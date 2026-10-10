const NATIVE_CHAT_SUBMIT_DELAY_MS = 500;
const ESC = '\u001B';
const VISUAL_ESC = '\u241B'; // ␛

// Each session gets a promise chain to serialize writes
const sendChains = new Map();

function formatBody(text) {
  const sanitized = text.replace(new RegExp(ESC, 'g'), VISUAL_ESC);
  if (!sanitized.includes('\n') && !sanitized.includes('\r')) {
    return sanitized;
  }
  const crOnly = sanitized.replace(/\r?\n/g, '\r');
  return `${ESC}[200~${crOnly}${ESC}[201~`;
}

function sendChat(session, text) {
  if (!session || !session.pty) return Promise.reject(new Error('Invalid session'));

  const sessionId = session.sessionId;
  let chain = sendChains.get(sessionId) || Promise.resolve();

  chain = chain.then(() => {
    return new Promise((resolve) => {
      try {
        // 1. Clear unsubmitted line
        session.pty.write('\x15');

        // 2. Body
        const body = formatBody(text);
        if (body) {
          session.pty.write(body);
        }

        // 3. Enter with delay
        setTimeout(() => {
          try {
            session.pty.write('\r');
          } catch {
            // ignore pty closed errors
          }
          resolve();
        }, NATIVE_CHAT_SUBMIT_DELAY_MS);
      } catch {
        resolve(); // proceed chain even on error
      }
    });
  });

  sendChains.set(sessionId, chain);

  // Clean up chain if it's the last one
  chain.finally(() => {
    if (sendChains.get(sessionId) === chain) {
      sendChains.delete(sessionId);
    }
  });

  return chain;
}

module.exports = {
  sendChat,
  formatBody,
  NATIVE_CHAT_SUBMIT_DELAY_MS,
};
