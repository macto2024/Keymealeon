// Browser error reporting.
//
// The page tells the Keymaeleon backend what it can see, the way a Sentry SDK would.
// This is the signal the coding agent does not have: the agent reads the source and the
// test output, but it never sees the running application. A green suite and a broken
// page is a fact only something watching both can know.
//
// Nothing here is required for the app to work. If the backend is not running, every
// report fails quietly and the checkout page behaves exactly as it would in production.

const ENDPOINT = 'http://127.0.0.1:5173/api/browser/report';
const HEARTBEAT_MS = 3000;

let current = { message: null };

async function send() {
  try {
    await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: location.href,
        ok: current.message === null,
        message: current.message,
      }),
    });
  } catch {
    // The backend is optional. A page that breaks when its telemetry is down is a worse page.
  }
}

/** Report a problem the page detected about itself. Repeats are not re-sent. */
export function reportError(message) {
  const text = String(message).slice(0, 300);
  if (text === current.message) return;
  current = { message: text };
  send();
}

/** Report that the page rendered correctly, clearing any previous error. */
export function reportHealthy() {
  if (current.message === null) return;
  current = { message: null };
  send();
}

addEventListener('error', event => reportError(event.error ? `${event.error.name}: ${event.error.message}` : event.message));
addEventListener('unhandledrejection', event => reportError(`UnhandledRejection: ${event.reason}`));

// A heartbeat keeps the backend's view fresh, and lets it notice when the tab closes.
send();
setInterval(send, HEARTBEAT_MS);
