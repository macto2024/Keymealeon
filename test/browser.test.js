import test from 'node:test';
import assert from 'node:assert/strict';
import { Runtime, emptyBrowserFact } from '../server/runtime.js';

const runtime = () => new Runtime({ root: null, command: null });

test('a report becomes context the keyboard can act on', () => {
  const six = runtime();
  six.setBrowser({ url: 'http://127.0.0.1:5174/', message: 'TypeError: cart total is not a number' });
  assert.equal(six.context.browser.connected, true);
  assert.equal(six.context.browser.error, 'TypeError: cart total is not a number');
  assert.equal(six.context.browser.url, 'http://127.0.0.1:5174/');
});

test('ok:true clears a standing error', () => {
  const six = runtime();
  six.setBrowser({ message: 'boom' });
  six.setBrowser({ ok: true });
  assert.equal(six.context.browser.error, null);
  assert.equal(six.context.browser.connected, true);
});

test('repeat reports do not churn the revision', () => {
  const six = runtime();
  six.setBrowser({ message: 'boom' });
  const revision = six.context.revision;
  six.setBrowser({ message: 'boom' });
  assert.equal(six.context.revision, revision);
});

test('untrusted text is clipped and normalised, never trusted', () => {
  const six = runtime();
  six.setBrowser({ message: `a\n\n   b${'x'.repeat(500)}`, url: 'y'.repeat(500) });
  assert.equal(six.context.browser.error.length, 300);
  assert.ok(six.context.browser.error.startsWith('a b'));
  assert.equal(six.context.browser.url.length, 200);
});

test('silence is not health: an idle tab drops its error rather than leaving it standing', () => {
  const six = runtime();
  six.setBrowser({ message: 'boom' });
  six.browserSeen = Date.now() - 11000;
  six.expireBrowser();
  assert.deepEqual(six.context.browser, emptyBrowserFact());
});

test('a fresh runtime reports no browser at all', () => {
  assert.equal(runtime().context.browser.connected, false);
});
