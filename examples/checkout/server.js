/**
 * ProofCast example — a zero-dependency checkout.
 *
 * The target of `proofcast demo`: a tiny product page with a real card-payment
 * form. ProofCast drives it in a real browser — types a test card, submits, and
 * watches the payment succeed — then records the whole thing as an MP4. It uses
 * ONLY Node's built-in `http` server, so `npm install` pulls nothing and it boots
 * in a second.
 *
 * The form uses standard `autocomplete` tokens (cc-number / cc-exp / cc-csc) so
 * ProofCast's generic demo driver fills it the way any real checkout would be.
 * The payment is dynamic: a fresh order number each run and a brief "processing"
 * step before the success state — nothing is faked on load, it is driven.
 */

import { createServer } from "node:http";

const port = Number(process.env.PORT) || 3000;

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Nova Audio — Checkout</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 28px 16px; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: radial-gradient(1200px 620px at 50% -10%, #14233f, #070b16); color: #e6edf7;
  }
  .shell { width: 880px; max-width: 96vw; display: grid; grid-template-columns: 1.05fr 1fr; gap: 22px; }
  @media (max-width: 760px) { .shell { grid-template-columns: 1fr; } }
  .brand { font-size: .72rem; letter-spacing: 3px; color: #7c8db3; text-transform: uppercase; }
  .product {
    background: linear-gradient(180deg, rgba(56,189,248,0.06), rgba(255,255,255,0.02));
    border: 1px solid rgba(255,255,255,0.08); border-radius: 18px; padding: 26px;
    display: flex; flex-direction: column;
  }
  .cans { margin: 18px 0 22px; align-self: center; filter: drop-shadow(0 18px 30px rgba(56,189,248,0.25)); }
  h1 { margin: 6px 0 6px; font-size: 1.5rem; }
  .desc { margin: 0 0 16px; color: #93a3c4; font-size: .9rem; }
  .price { font-size: 1.9rem; font-weight: 800; }
  .price small { font-size: .8rem; color: #93a3c4; font-weight: 500; margin-left: 6px; }
  .pay {
    background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.09);
    border-radius: 18px; padding: 24px; box-shadow: 0 24px 60px rgba(0,0,0,0.45);
  }
  .pay h2 { margin: 0 0 16px; font-size: 1.05rem; }
  label { display: block; font-size: .74rem; color: #a7b4d0; margin: 12px 0 6px; }
  input {
    width: 100%; padding: 11px 12px; border-radius: 10px; font-size: .95rem;
    border: 1px solid rgba(255,255,255,0.14); background: #0a1120; color: #e6edf7;
  }
  input:focus { outline: none; border-color: #38bdf8; box-shadow: 0 0 0 3px rgba(56,189,248,0.22); }
  .row { display: flex; gap: 12px; }
  .row > div { flex: 1; }
  button {
    margin-top: 20px; width: 100%; padding: 13px; border: 0; border-radius: 11px; cursor: pointer;
    font-size: 1rem; font-weight: 700; color: #04121f;
    background: linear-gradient(90deg, #38bdf8, #22d3ee);
  }
  button:hover { filter: brightness(1.05); }
  button:disabled { filter: grayscale(.3) brightness(.9); cursor: default; }
  .success { text-align: center; padding: 14px 6px; }
  .check {
    width: 58px; height: 58px; border-radius: 50%; margin: 4px auto 14px; display: grid; place-items: center;
    background: rgba(74,222,128,0.15); border: 1px solid rgba(74,222,128,0.4); color: #4ade80; font-size: 30px;
  }
  .success h2 { color: #4ade80; margin: 0 0 6px; }
  .success .order { color: #93a3c4; font-size: .9rem; }
</style>
</head>
<body>
  <main class="shell">
    <section class="product">
      <div class="brand">◆ Nova Audio</div>
      <svg class="cans" width="150" height="130" viewBox="0 0 150 130" fill="none" aria-hidden="true">
        <path d="M25 78 V64 a50 50 0 0 1 100 0 V78" stroke="#38bdf8" stroke-width="7" fill="none" stroke-linecap="round"/>
        <rect x="14" y="74" width="26" height="42" rx="12" fill="#22d3ee"/>
        <rect x="110" y="74" width="26" height="42" rx="12" fill="#22d3ee"/>
      </svg>
      <h1>Nova ANC Headphones</h1>
      <p class="desc">Adaptive noise-cancelling · 40-hour battery · Quiet mode</p>
      <div class="price">$149.00<small>one-time</small></div>
    </section>

    <section class="pay" id="pay">
      <h2>Pay with card</h2>
      <form id="checkout" novalidate>
        <label for="cardnumber">Card number</label>
        <input id="cardnumber" name="cardnumber" autocomplete="cc-number" inputmode="numeric"
               placeholder="1234 1234 1234 1234" />
        <label for="ccname">Name on card</label>
        <input id="ccname" name="ccname" autocomplete="cc-name" type="text" placeholder="Full name" />
        <div class="row">
          <div>
            <label for="ccexp">Expiry</label>
            <input id="ccexp" name="ccexp" autocomplete="cc-exp" placeholder="MM / YY" />
          </div>
          <div>
            <label for="cccvc">CVC</label>
            <input id="cccvc" name="cccvc" autocomplete="cc-csc" inputmode="numeric" placeholder="CVC" />
          </div>
        </div>
        <button type="submit" id="paybtn">Pay $149.00</button>
      </form>
    </section>
  </main>
  <script>
    (function () {
      var form = document.getElementById('checkout');
      var pay = document.getElementById('pay');
      var btn = document.getElementById('paybtn');
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var card = document.getElementById('cardnumber').value.replace(/\\s+/g, '');
        if (card.length < 12) {
          btn.textContent = 'Enter your card number';
          return;
        }
        btn.disabled = true;
        btn.textContent = 'Processing…';
        // A real (simulated) async payment: a brief round-trip, then success.
        setTimeout(function () {
          var order = 100 + Math.floor(Math.random() * 900);
          pay.innerHTML =
            '<div class="success">' +
            '<div class="check">✓</div>' +
            '<h2>Payment successful</h2>' +
            '<div class="order">Order #' + order + ' · Nova ANC Headphones</div>' +
            '</div>';
        }, 480);
      });
    })();
  </script>
</body>
</html>`;

const server = createServer((req, res) => {
  if (req.url === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE);
});

// Bind 0.0.0.0 so both the prover's 127.0.0.1 probe and Chromium's `localhost`
// navigation reach it — mirroring how the Docker sandbox publishes the port.
server.listen(port, "0.0.0.0", () => {
  console.log(`ProofCast checkout example listening on ${port}`);
});
