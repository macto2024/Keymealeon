# Checkout demo

The application the [3:30 demo](../DEMO.md) is performed against. It contains a deliberate,
carefully shaped bug.

## The bug, and why it is shaped this way

Two defects in one page, and only one of them is visible to a test suite.

**`src/format.js` — caught by tests.** `Math.round` returns a Number, so trailing zeros vanish
and `20` formats as `$20`. Three assertions in `test/format.test.js` fail on this. A coding agent
fixes it in one line with `toFixed(2)`.

**`src/cart.js` — caught by nothing.** The storefront API returns `price` as a display string
(`"$149.00"`). Multiplying that by a quantity yields `NaN`, so the total is `NaN`. Every case in
`test/cart.test.js` builds its own items with numeric prices, so the suite never touches the shape
of the real data.

The consequence is the point of the whole demo:

```
before   4 passed, 2 failed     page shows  $NaN
after    6 passed, 0 failed     page shows  $NaN
```

The agent's fix is real, the tests genuinely go green, and the application is exactly as broken as
it was. The agent read the source and the test output. It never saw the page.

## Run it

```sh
./init.sh          # give the folder its own Git repository, so Git Diff has a baseline
npm start          # http://127.0.0.1:5174
npm test           # 4 passed, 2 failed
```

Node 18+, no dependencies.

## Error reporting

`src/report.js` posts what the page can see to `http://127.0.0.1:5173/api/browser/report`, the way
a Sentry SDK would — on `window.onerror`, on unhandled rejections, and on a three-second heartbeat.
When the rendered total is not a finite number the page says so; when it renders correctly it clears
the error.

That signal is the one the coding agent does not have, and it is what lets the keyboard know the
work is not finished while the test suite insists that it is.

If the backend is not running, every report fails quietly and the page behaves normally. Telemetry
that can break the app it measures is worse than no telemetry.
