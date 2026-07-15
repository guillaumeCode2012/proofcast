/**
 * ProofCast example — a zero-dependency signup app.
 *
 * This is the target of the "2-minute local trial": a tiny, self-contained web
 * feature that ProofCast can prove for real, with no API key, no Telegram, and
 * no Vercel. It uses ONLY Node's built-in `http` server — so `npm install` pulls
 * nothing from the network and the whole thing boots in a second.
 *
 * The prover boots this, drives the signup form in a real Chromium, and records
 * an MP4 of the account actually being created. See ../../README.md → Quickstart.
 */

import { createServer } from "node:http";

// The prover/sandbox publishes the app on this port (env PORT), falling back to
// 3000 for a manual `node server.js`.
const port = Number(process.env.PORT) || 3000;

/** The whole feature: one self-contained page, no external assets, no console errors. */
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Acme — Create your account</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    background: radial-gradient(1200px 600px at 50% -10%, #1e293b, #0f172a);
    color: #e2e8f0;
  }
  .card {
    width: 360px; max-width: 92vw; padding: 32px 28px; border-radius: 16px;
    background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
    box-shadow: 0 20px 60px rgba(0,0,0,0.45);
  }
  h1 { margin: 0 0 4px; font-size: 1.5rem; }
  p.sub { margin: 0 0 22px; color: #94a3b8; font-size: 0.9rem; }
  label { display: block; font-size: 0.8rem; color: #cbd5e1; margin: 14px 0 6px; }
  input {
    width: 100%; padding: 11px 12px; border-radius: 9px; font-size: 0.95rem;
    border: 1px solid rgba(255,255,255,0.14); background: #0b1220; color: #e2e8f0;
  }
  input:focus { outline: none; border-color: #38bdf8; box-shadow: 0 0 0 3px rgba(56,189,248,0.2); }
  button {
    margin-top: 22px; width: 100%; padding: 12px; border: 0; border-radius: 9px;
    font-size: 0.98rem; font-weight: 600; color: #06263a; cursor: pointer;
    background: linear-gradient(90deg, #38bdf8, #22d3ee);
  }
  button:hover { filter: brightness(1.05); }
  #result { margin-top: 18px; min-height: 22px; font-size: 0.92rem; color: #4ade80; text-align: center; }
</style>
</head>
<body>
  <main class="card">
    <h1>Create your account</h1>
    <p class="sub">Start your 14-day free trial. No credit card required.</p>
    <form id="signup" novalidate>
      <label for="name">Full name</label>
      <input id="name" name="name" type="text" autocomplete="name" placeholder="Ada Lovelace" />
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="email" placeholder="you@example.com" />
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="new-password" placeholder="••••••••" />
      <button type="submit">Create account</button>
    </form>
    <div id="result" role="status" aria-live="polite"></div>
  </main>
  <script>
    document.getElementById('signup').addEventListener('submit', function (event) {
      event.preventDefault();
      var email = document.getElementById('email').value.trim();
      var password = document.getElementById('password').value;
      var result = document.getElementById('result');
      if (!email || !password) {
        result.style.color = '#f87171';
        result.textContent = 'Please fill in your email and a password.';
        return;
      }
      result.style.color = '#4ade80';
      result.textContent = 'Account created for ' + email + ' ✓';
    });
  </script>
</body>
</html>`;

const server = createServer((req, res) => {
  // Answer the browser's automatic favicon probe so it never logs a console error.
  if (req.url === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(PAGE);
});

// Bind on 0.0.0.0 so both the prover's 127.0.0.1 port probe and Chromium's
// `localhost` navigation reach it — mirroring how the Docker sandbox publishes.
server.listen(port, "0.0.0.0", () => {
  console.log(`ProofCast signup example listening on ${port}`);
});
