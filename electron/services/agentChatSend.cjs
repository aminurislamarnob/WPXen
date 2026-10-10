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

function sendChat(session, text, images = []) {
  if (!session || !session.pty) return Promise.reject(new Error('Invalid session'));

  const sessionId = session.sessionId;
  let chain = sendChains.get(sessionId) || Promise.resolve();

  chain = chain.then(() => {
    return new Promise((resolve) => {
      try {
        // 1. Clear unsubmitted line
        session.pty.write('\x15');

        // 2. Images
        for (const img of images) {
          session.pty.write(`${ESC}[200~${img}${ESC}[201~`);
        }

        // 3. Body
        const body = formatBody(text);
        if (body) {
          if (images.length > 0) session.pty.write(' ');
          session.pty.write(body);
        }

        // 4. Enter with delay
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

const NATIVE_CHAT_QUESTION_STEP_MS = 1000;

function sendChatAnswer(session, groups) {
  if (!session || !session.pty) return Promise.reject(new Error('Invalid session'));

  const sessionId = session.sessionId;
  let chain = sendChains.get(sessionId) || Promise.resolve();

  for (const group of groups) {
    chain = chain.then(() => {
      return new Promise((resolve) => {
        try {
          if (group.raw !== undefined) {
            session.pty.write(group.raw);
          } else if (group.text !== undefined) {
            session.pty.write(formatBody(group.text));
          }
        } catch {
          // ignore
        }
        setTimeout(resolve, NATIVE_CHAT_QUESTION_STEP_MS);
      });
    });
  }

  sendChains.set(sessionId, chain);
  chain.finally(() => {
    if (sendChains.get(sessionId) === chain) {
      sendChains.delete(sessionId);
    }
  });

  return chain;
}

module.exports = {
  sendChat,
  sendChatAnswer,
  formatBody,
  NATIVE_CHAT_SUBMIT_DELAY_MS,
  NATIVE_CHAT_QUESTION_STEP_MS,
};
