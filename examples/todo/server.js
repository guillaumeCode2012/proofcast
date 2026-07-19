/**
 * ProofCast example — a zero-dependency task list.
 *
 * The third shape ProofCast proves, next to signup (auth) and checkout
 * (payment): a stateful CRUD feature. There is no password and no card here —
 * just a text field and an "Add task" button — so it is what proves the generic
 * demo driver can drive an ordinary feature, not only credential forms.
 *
 * ProofCast boots this, types a task, submits, and watches the list actually
 * grow (the item appears, the counter goes up, the empty state disappears), then
 * records the whole thing as an MP4. It uses ONLY Node's built-in `http` server,
 * so `npm install` pulls nothing from the network and it boots in a second.
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
<title>Momentum — Today's tasks</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 28px 16px; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: radial-gradient(1100px 600px at 50% -10%, #1a2b22, #070d0a); color: #e6f0ea;
  }
  .card {
    width: 480px; max-width: 94vw; padding: 28px 26px; border-radius: 18px;
    background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.09);
    box-shadow: 0 24px 60px rgba(0,0,0,0.45);
  }
  .brand { font-size: .72rem; letter-spacing: 3px; color: #7fa894; text-transform: uppercase; }
  h1 { margin: 8px 0 2px; font-size: 1.45rem; }
  .sub { margin: 0 0 20px; color: #8fae9f; font-size: .88rem; }
  form { display: flex; gap: 10px; }
  input {
    flex: 1; padding: 11px 12px; border-radius: 10px; font-size: .95rem;
    border: 1px solid rgba(255,255,255,0.14); background: #0a1410; color: #e6f0ea;
  }
  input:focus { outline: none; border-color: #34d399; box-shadow: 0 0 0 3px rgba(52,211,153,0.2); }
  button {
    padding: 11px 18px; border: 0; border-radius: 10px; cursor: pointer;
    font-size: .95rem; font-weight: 700; color: #04231a;
    background: linear-gradient(90deg, #34d399, #6ee7b7);
  }
  button:hover { filter: brightness(1.05); }
  ul { list-style: none; margin: 20px 0 0; padding: 0; }
  li {
    display: flex; align-items: center; gap: 11px; padding: 12px 4px;
    border-bottom: 1px solid rgba(255,255,255,0.07); font-size: .96rem;
    animation: slide .28s ease-out;
  }
  @keyframes slide { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
  li input[type="checkbox"] { flex: none; width: 17px; height: 17px; accent-color: #34d399; cursor: pointer; }
  li.done span { text-decoration: line-through; color: #6b8a7b; }
  .empty { margin: 22px 0 4px; text-align: center; color: #6b8a7b; font-size: .9rem; }
  .count { margin-top: 18px; font-size: .8rem; color: #8fae9f; text-align: right; }
</style>
</head>
<body>
  <main class="card">
    <div class="brand">◆ Momentum</div>
    <h1>Today's tasks</h1>
    <p class="sub">Everything you meant to ship today, in one place.</p>

    <form id="add-task">
      <input id="task" name="task" type="text" autocomplete="off" placeholder="Add a task…" />
      <button type="submit">Add task</button>
    </form>

    <ul id="list"></ul>
    <p class="empty" id="empty">Nothing yet — add your first task above.</p>
    <div class="count" id="count" role="status" aria-live="polite">0 tasks</div>
  </main>
  <script>
    (function () {
      var form = document.getElementById('add-task');
      var field = document.getElementById('task');
      var list = document.getElementById('list');
      var empty = document.getElementById('empty');
      var count = document.getElementById('count');

      function refresh() {
        var items = list.querySelectorAll('li');
        var open = list.querySelectorAll('li:not(.done)').length;
        empty.style.display = items.length === 0 ? '' : 'none';
        count.textContent = items.length === 0
          ? '0 tasks'
          : open + ' open · ' + items.length + ' total';
      }

      form.addEventListener('submit', function (event) {
        event.preventDefault();
        var title = field.value.trim();
        if (!title) {
          field.focus();
          return;
        }

        var item = document.createElement('li');
        var box = document.createElement('input');
        box.type = 'checkbox';
        var label = document.createElement('span');
        label.textContent = title;
        box.addEventListener('change', function () {
          item.classList.toggle('done', box.checked);
          refresh();
        });
        item.appendChild(box);
        item.appendChild(label);
        list.appendChild(item);

        field.value = '';
        field.focus();
        refresh();
      });

      refresh();
    })();
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

// Bind 0.0.0.0 so both the prover's 127.0.0.1 probe and Chromium's `localhost`
// navigation reach it — mirroring how the Docker sandbox publishes the port.
server.listen(port, "0.0.0.0", () => {
  console.log(`ProofCast todo example listening on ${port}`);
});
