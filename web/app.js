// SPDX-License-Identifier: AGPL-3.0-only
// Munin's page: the list of timelines, one timeline as a vertical line of typed entries, and the threads on them.
// No framework: the server renders Markdown to safe HTML, and everything else here is built as DOM nodes.

const TYPES = [
  ["decision", "Decision", "Decisions"],
  ["action", "Action", "Actions"],
  ["result", "Result", "Results"],
  ["finding", "Finding", "Findings"],
  ["question", "Open question", "Open questions"],
  ["milestone", "Milestone", "Milestones"],
];
const TYPE_NAME = Object.fromEntries(TYPES.map(([k, n]) => [k, n]));
const LINK_WORDS = {
  led_to: ["Led to", "Came from"],
  answers: ["Answers", "Answered by"],
  supersedes: ["Supersedes", "Superseded by"],
  relates: ["Relates to", "Related from"],
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const S = {
  me: null,
  dir: null,
  tl: null,
  entries: [],
  byId: new Map(),
  links: [],
  open: new Set(),
  active: null,
  stats: null,
  linked: new Map(),
  panel: null,
  controls: null,
  gen: 0,
  next: null,
  floor: null,
  week: "",
  lastDate: "",
  matched: 0,
  loading: false,
  scrolled: false,
};
const main = document.getElementById("main");

// --- small helpers --------------------------------------------------------------------------------------------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style")
      el.style.cssText = v; // through the CSSOM, which the CSP allows; a style attribute it would refuse
    else if (k === "html")
      el.innerHTML = v; // only ever server-rendered, escaped Markdown
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat())
    if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
const mk = (type) => h("span", { class: `mk ${type}`, "aria-hidden": "true" });

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers:
      body !== undefined || method !== "GET" ? { "content-type": "application/json", "x-munin": "1" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `${res.status}`), { status: res.status });
  return data;
}

function fmtDate(d) {
  const [y, m, day] = d.split("-").map(Number);
  return `${day} ${MONTHS[m - 1]} ${y}`;
}
function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return iso.slice(0, 10);
}
function lines(text) {
  return String(text || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}
function pairs(text, sep) {
  return lines(text).map((l) => {
    const i = l.indexOf(sep);
    return i < 0 ? [l, ""] : [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  });
}

// --- theme ----------------------------------------------------------------------------------------------------
const themeBtn = document.getElementById("theme");
themeBtn.addEventListener("click", () => {
  const cur = document.documentElement.dataset.theme || "system";
  const next = cur === "system" ? "light" : cur === "light" ? "dark" : "system";
  if (next === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = next;
  themeBtn.title = `Theme: ${next}`;
  try {
    if (next === "system") localStorage.removeItem("munin-theme");
    else localStorage.setItem("munin-theme", next);
  } catch {}
});

// --- routing --------------------------------------------------------------------------------------------------
document.addEventListener("click", (ev) => {
  const a = ev.target.closest("a");
  if (!a || a.target || ev.metaKey || ev.ctrlKey || ev.shiftKey) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || url.pathname.startsWith("/auth/") || url.pathname.startsWith("/api/"))
    return;
  if (url.pathname === location.pathname && url.hash) return;
  ev.preventDefault();
  history.pushState(null, "", url.pathname + url.search + url.hash);
  route();
});
window.addEventListener("popstate", route);

async function boot() {
  S.me = await api("GET", "/api/me");
  document.getElementById("version").textContent = `version ${S.me.version}`;
  const who = document.getElementById("who");
  who.replaceChildren();
  if (S.me.user) {
    who.append(
      h(
        "span",
        {},
        S.me.user.name,
        S.me.user.isAdmin ? h("span", { class: "tag", style: "margin-left:6px" }, "admin") : null,
      ),
      " ",
      h(
        "form",
        { method: "post", action: "/auth/logout" },
        h("button", { class: "linkish", type: "submit" }, "Sign out"),
      ),
    );
  }
  route();
}

function route() {
  const p = location.pathname;
  if (!S.me.user) return signin();
  if (p === "/signin") return history.replaceState(null, "", "/"), home();
  const m = /^\/t\/([a-z0-9-]+)\/?$/.exec(p);
  if (m) return timeline(m[1]);
  return home();
}

// --- sign in --------------------------------------------------------------------------------------------------
function signin() {
  document.title = "Sign in · Munin";
  const back =
    location.pathname === "/signin"
      ? new URLSearchParams(location.search).get("return") || "/"
      : location.pathname;
  const box = h(
    "div",
    { class: "signin" },
    h("p", { class: "eyebrow" }, "Munin"),
    h("h1", {}, "Where it started, what we decided, and why."),
    h(
      "p",
      { class: "muted" },
      "Project timelines of decisions, actions, results and findings, with threads on every entry. Sign in to see the timelines shared with you.",
    ),
  );
  if (S.me.mode === "oidc") {
    box.append(
      h(
        "p",
        {},
        h("a", { class: "button", href: `/auth/login?return=${encodeURIComponent(back)}` }, "Sign in"),
      ),
    );
  } else {
    box.append(
      h("p", { class: "muted" }, "This is a development install: pick a made-up person to be."),
      h(
        "div",
        { class: "people" },
        S.me.devUsers.map((u) =>
          h(
            "form",
            { method: "post", action: "/auth/dev" },
            h("input", { type: "hidden", name: "username", value: u.username }),
            h("input", { type: "hidden", name: "return", value: back }),
            h(
              "button",
              { class: "button ghost", type: "submit" },
              u.name,
              h("span", { class: "mono muted" }, `@${u.username}`),
            ),
          ),
        ),
      ),
    );
  }
  main.replaceChildren(box);
}

// --- the list of timelines ------------------------------------------------------------------------------------
async function home() {
  document.title = "Munin";
  S.tl = null;
  const { timelines } = await api("GET", "/api/timelines");
  const form = h("form", { class: "new", hidden: true });
  const err = h("p", { class: "error" });
  form.append(
    h("h3", {}, "A new timeline"),
    h(
      "label",
      { class: "field" },
      "Name",
      h("input", {
        type: "text",
        name: "title",
        required: true,
        maxlength: 120,
        placeholder: "The PCCT study",
      }),
    ),
    h(
      "label",
      { class: "field" },
      "What it follows",
      h("input", { type: "text", name: "summary", maxlength: 2000, placeholder: "One sentence" }),
    ),
    h(
      "label",
      { class: "field" },
      "Address",
      h("small", {}, "Letters, digits and dashes. Empty: made from the name."),
      h("input", { type: "text", name: "slug", maxlength: 40 }),
    ),
    err,
    h(
      "div",
      { class: "tools" },
      h("button", { class: "button", type: "submit" }, "Create"),
      h("button", { class: "linkish", type: "button", onclick: () => (form.hidden = true) }, "Cancel"),
    ),
  );
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    try {
      const r = await api("POST", "/api/timelines", {
        title: fd.get("title"),
        summary: fd.get("summary"),
        slug: fd.get("slug"),
      });
      history.pushState(null, "", `/t/${r.slug}`);
      route();
    } catch (e) {
      err.textContent = e.message;
    }
  });
  const head = h(
    "div",
    { class: "head" },
    h("div", {}, h("p", { class: "eyebrow" }, "Munin"), h("h1", {}, "Timelines")),
    S.me.mayCreate
      ? h(
          "button",
          { class: "button", onclick: () => ((form.hidden = false), form.querySelector("input").focus()) },
          "New timeline",
        )
      : null,
  );
  const cards = h("div", { class: "cards" });
  for (const t of timelines) {
    const total = Object.values(t.counts).reduce((a, b) => a + b, 0);
    cards.append(
      h(
        "a",
        { class: "card", href: `/t/${t.slug}` },
        h("h2", {}, t.title),
        t.summary ? h("p", { class: "muted" }, t.summary) : null,
        h(
          "div",
          { class: "counts" },
          TYPES.filter(([k]) => t.counts[k]).map(([k, , plural]) =>
            h("span", { class: k }, mk(k), " ", `${t.counts[k]} ${plural.toLowerCase()}`),
          ),
        ),
        h(
          "p",
          { class: "muted", style: "font-size:13px" },
          total ? `${fmtDate(t.first)} to ${fmtDate(t.last)} · ` : "Empty · ",
          `${t.owner.name} · ${t.access === "owner" ? "you manage it" : `you may ${t.access}`}`,
        ),
      ),
    );
  }
  if (!timelines.length) cards.append(h("p", { class: "muted" }, "No timeline is shared with you yet."));
  main.replaceChildren(head, form, cards);
}

// --- a timeline -----------------------------------------------------------------------------------------------
// Newest first, a week at a time: the first answer is the latest week with matching entries, and older weeks
// load as the person scrolls towards the end. Filters are applied by the server, so they reach unloaded weeks.
const F = {
  types: new Set(TYPES.map(([k]) => k)),
  record: "",
  tag: "",
  from: "",
  to: "",
  q: "",
  threads: false,
  stale: false,
};
const WIDE = window.matchMedia("(min-width: 1100px)");
WIDE.addEventListener("change", () => placePanel());

function clearFilters(stale = false) {
  Object.assign(F, {
    types: new Set(TYPES.map(([k]) => k)),
    record: "",
    tag: "",
    from: "",
    to: "",
    q: "",
    threads: false,
    stale,
  });
}

async function timeline(slug, keepOpen) {
  let data;
  try {
    data = await api("GET", `/api/timelines/${slug}?entries=none`);
  } catch (e) {
    main.replaceChildren(
      h(
        "div",
        { class: "pad" },
        h("h1", {}, "Not here"),
        h("p", { class: "muted" }, e.message),
        h("p", {}, h("a", { href: "/" }, "All timelines")),
      ),
    );
    return;
  }
  const through = keepOpen && S.tl?.slug === slug ? S.floor : null;
  if (!keepOpen || S.tl?.slug !== slug) {
    S.open = new Set();
    S.active = null;
  }
  S.tl = data.timeline;
  S.stats = data.stats;
  S.links = data.links;
  S.linked = new Map(data.linked.map((x) => [x.id, x]));
  if (!S.dir) S.dir = await api("GET", "/api/directory").catch(() => ({ users: [], groups: [] }));
  document.title = `${S.tl.title} · Munin`;
  const t = S.tl;
  const canEdit = ["edit", "owner"].includes(t.access);

  const head = h(
    "div",
    { class: "tl-head" },
    h("p", { class: "eyebrow" }, "Timeline"),
    h("h1", {}, t.title),
    t.summary ? h("p", { class: "lede" }, t.summary) : null,
    h(
      "p",
      { class: "muted", style: "font-size:13px" },
      t.owner.username === "munin" ? "Kept by the importer" : `${t.owner.name} owns it`,
      ` · ${t.owner.username === S.me.user.username ? "yours" : t.access === "owner" ? "you manage it as an administrator" : `you may ${t.access}`}`,
      t.lastImport ? ` · imported ${ago(t.lastImport.at)}` : "",
    ),
    h(
      "div",
      { class: "actions" },
      canEdit ? h("button", { class: "button small", onclick: () => editEntry(null) }, "Add an entry") : null,
      t.access === "owner" ? h("button", { class: "button ghost small", onclick: share }, "Share") : null,
      t.access === "owner"
        ? h("button", { class: "button ghost small", onclick: settings }, "Settings")
        : null,
    ),
  );
  S.panel = h("section", { class: "chat", "aria-label": "Threads" });
  S.controls = controls();
  const more = h("div", { id: "more", class: "more" });
  main.replaceChildren(
    head,
    picture(canEdit),
    S.controls,
    h(
      "div",
      { class: "tl-body" },
      h("div", { class: "tl-main" }, h("div", { id: "list" }), more),
      h("aside", { class: "side" }),
    ),
  );
  const hash = /^#e(\d+)$/.exec(location.hash);
  const id = hash ? Number(hash[1]) : null;
  if (id) {
    S.open.add(id);
    S.active = id;
  }
  if (!(await load({ until: id, through }))) return;
  if (S.active && !S.byId.has(S.active)) S.active = [...S.open].filter((x) => S.byId.has(x)).pop() ?? null;
  markActive();
  drawPanel();
  if (id) document.getElementById(`e${id}`)?.scrollIntoView({ block: "start", behavior: "auto" });
}

function picture(canEdit) {
  const p = S.tl.picture;
  const open = S.stats.openQuestions;
  const box = h("div", { class: "picture", id: "picture" });
  const sec = (title, html, extra) =>
    h(
      "section",
      {},
      h("h3", {}, title),
      html ? h("div", { class: "md", html }) : h("p", { class: "muted" }, "Nothing written yet."),
      extra,
    );
  const qlist = open.length
    ? h(
        "ul",
        { class: "qlist" },
        open.map((q) =>
          h(
            "li",
            { class: "question" },
            mk("question"),
            h(
              "span",
              {},
              h(
                "a",
                { href: `#e${q.id}`, onclick: (ev) => (ev.preventDefault(), openEntry(q.id, true)) },
                q.title,
              ),
              q.waitingOn ? h("span", { class: "muted" }, ` · waits on ${q.waitingOn}`) : null,
            ),
          ),
        ),
      )
    : null;
  box.append(
    sec("Where we are", p.nowHtml),
    sec("What is next", p.nextHtml),
    sec("Waiting on", p.waitingHtml, qlist),
  );
  // Collapsed to its first lines until the person asks for more; the choice is remembered in this browser.
  const key = `munin-picture:${S.tl.slug}`;
  let expanded = false;
  try {
    expanded = localStorage.getItem(key) === "open";
  } catch {}
  const btn = h("button", { class: "linkish", type: "button", "aria-controls": "picture" });
  const note = h("span", { class: "muted" });
  const set = (v) => {
    expanded = v;
    box.classList.toggle("collapsed", !v);
    btn.textContent = v ? "Show less" : "Show more of the big picture";
    btn.setAttribute("aria-expanded", String(v));
    note.textContent =
      !v && open.length ? `${open.length} open question${open.length > 1 ? "s" : ""} waiting` : "";
    try {
      if (v) localStorage.setItem(key, "open");
      else localStorage.removeItem(key);
    } catch {}
  };
  btn.addEventListener("click", () => set(!expanded));
  box.addEventListener("click", (ev) => {
    if (!expanded && !ev.target.closest("a, button")) set(true);
  });
  set(expanded);
  return h(
    "div",
    { class: "picture-wrap" },
    box,
    h(
      "div",
      { class: "picture-tools" },
      btn,
      note,
      canEdit
        ? h("button", { class: "linkish", onclick: () => editPicture() }, "Edit the big picture")
        : null,
    ),
  );
}

function controls() {
  const counts = S.stats.counts;
  const chips = h(
    "div",
    { class: "stats", role: "group", "aria-label": "Show types" },
    TYPES.map(([k, , plural]) =>
      h(
        "button",
        {
          class: `chip ${k}`,
          type: "button",
          "aria-pressed": String(F.types.has(k)),
          onclick: (ev) => {
            if (ev.altKey || ev.shiftKey) {
              F.types = new Set([k]);
            } else if (F.types.has(k)) F.types.delete(k);
            else F.types.add(k);
            for (const b of chips.children)
              b.setAttribute("aria-pressed", String(F.types.has(b.dataset.type)));
            load();
          },
          "data-type": k,
          title: "Click to show or hide; shift-click to show only this",
        },
        mk(k),
        plural,
        h("span", { class: "n" }, counts[k] || 0),
      ),
    ),
  );
  const records = S.stats.tags
    .filter((t) => /^record \d+$/.test(t))
    .sort((a, b) => Number(a.slice(7)) - Number(b.slice(7)));
  const tags = S.stats.tags.filter((t) => !/^record \d+$/.test(t));
  const sel = (name, label, opts, all) =>
    h(
      "label",
      {},
      label,
      h(
        "select",
        { onchange: (ev) => ((F[name] = ev.target.value), load()) },
        h("option", { value: "" }, all),
        opts.map((o) => h("option", { value: o, selected: F[name] === o }, o)),
      ),
    );
  let timer;
  const q = h("input", {
    type: "search",
    value: F.q,
    placeholder: "Words in titles, summaries and texts",
    oninput: (ev) => {
      F.q = ev.target.value;
      clearTimeout(timer);
      timer = setTimeout(() => load(), 250);
    },
  });
  const filters = h(
    "div",
    { class: "filters" },
    h("label", { class: "q" }, "Search", q),
    sel("record", "Record", records, "Any record"),
    sel("tag", "Tag", tags, "Any tag"),
    h(
      "label",
      {},
      "From",
      h("input", { type: "date", value: F.from, onchange: (ev) => ((F.from = ev.target.value), load()) }),
    ),
    h(
      "label",
      {},
      "To",
      h("input", { type: "date", value: F.to, onchange: (ev) => ((F.to = ev.target.value), load()) }),
    ),
    h(
      "button",
      {
        class: "button ghost small",
        type: "button",
        onclick: () => {
          clearFilters();
          redrawControls();
          load();
        },
      },
      "Clear",
    ),
  );
  const toggles = h(
    "div",
    { class: "shown" },
    h("span", { id: "shown-n" }),
    h(
      "label",
      {},
      h("input", {
        type: "checkbox",
        checked: F.threads,
        onchange: (ev) => ((F.threads = ev.target.checked), load()),
      }),
      "Open threads only",
    ),
    S.stats.stale
      ? h(
          "label",
          {},
          h("input", {
            type: "checkbox",
            checked: F.stale,
            onchange: (ev) => ((F.stale = ev.target.checked), load()),
          }),
          "Entries gone from their source",
        )
      : null,
  );
  return h("div", { class: "controls" }, chips, filters, toggles);
}

function redrawControls() {
  const fresh = controls();
  S.controls?.replaceWith(fresh);
  S.controls = fresh;
}

function page(extra = {}) {
  const p = new URLSearchParams();
  if (F.types.size !== TYPES.length) p.set("types", [...F.types].join(","));
  for (const k of ["record", "tag", "from", "to"]) if (F[k]) p.set(k, F[k]);
  if (F.q.trim()) p.set("q", F.q.trim());
  if (F.threads) p.set("threads", "1");
  if (F.stale) p.set("stale", "1");
  for (const [k, v] of Object.entries(extra)) if (v) p.set(k, String(v));
  return api("GET", `/api/timelines/${S.tl.slug}/entries?${p}`);
}

/** Loads the list afresh: the latest week, or down to an entry (`until`) or a date (`through`). */
async function load({ until = null, through = null } = {}) {
  const gen = ++S.gen;
  const list = document.getElementById("list");
  if (!list) return false;
  let r;
  try {
    r = await page({ until, through });
    if (gen !== S.gen) return false;
    if (until && r.until && !r.until.found) {
      // The linked entry is hidden by the filters: clear them rather than show a page without it.
      clearFilters(r.until.stale);
      redrawControls();
      r = await page({ until, through });
      if (gen !== S.gen) return false;
    }
  } catch (e) {
    if (gen === S.gen) list.replaceChildren(h("p", { class: "error pad" }, e.message));
    return false;
  }
  S.entries = [];
  S.byId = new Map();
  S.week = "";
  S.lastDate = "";
  S.floor = null;
  S.matched = r.matched;
  S.scrolled = false;
  list.replaceChildren(h("div", { class: "rail" }));
  append(r);
  return true;
}

async function loadMore() {
  if (!S.next || S.loading) return;
  S.loading = true;
  const gen = S.gen;
  drawMore();
  try {
    const r = await page({ before: S.next });
    if (gen === S.gen) append(r);
  } catch (e) {
    if (gen === S.gen)
      document.getElementById("more")?.replaceChildren(h("p", { class: "error" }, e.message));
    return;
  } finally {
    S.loading = false;
  }
  if (gen !== S.gen) return;
  drawMore();
  if (nearEnd()) loadMore();
}

function append(r) {
  const rail = document.querySelector("#list .rail");
  if (!rail) return;
  for (const e of r.entries) {
    S.entries.push(e);
    S.byId.set(e.id, e);
    const w = weekOf(e.date);
    if (w.start !== S.week) {
      S.week = w.start;
      S.lastDate = "";
      rail.append(weekEl(w));
    }
    rail.append(entryEl(e, e.date !== S.lastDate));
    S.lastDate = e.date;
  }
  S.next = r.next;
  if (S.entries.length) S.floor = weekOf(S.entries[S.entries.length - 1].date).start;
  else
    rail.append(
      h(
        "p",
        { class: "muted pad" },
        S.stats.total + S.stats.stale ? "Nothing matches these filters." : "No entries yet.",
      ),
    );
  const n = document.getElementById("shown-n");
  if (n) n.textContent = `${S.matched} of ${S.stats.total} entries`;
  drawMore();
}

function drawMore() {
  const more = document.getElementById("more");
  if (!more) return;
  if (S.loading) more.replaceChildren(h("p", { class: "muted" }, "Loading older weeks…"));
  else if (S.next)
    more.replaceChildren(
      h("button", { class: "button ghost small", type: "button", onclick: () => loadMore() }, "Older weeks"),
    );
  else more.replaceChildren(S.entries.length ? h("p", { class: "muted" }, "The start of the timeline.") : "");
}

// Older weeks load when the person scrolls (or wheels, or swipes) near the end of what is loaded.
function nearEnd() {
  const more = document.getElementById("more");
  return !!more && S.scrolled && more.getBoundingClientRect().top < window.innerHeight + 400;
}
let scrollTick = false;
function onScroll() {
  if (!S.tl || scrollTick) return;
  scrollTick = true;
  requestAnimationFrame(() => {
    scrollTick = false;
    S.scrolled = true;
    if (S.next && !S.loading && nearEnd()) loadMore();
  });
}
for (const ev of ["scroll", "wheel", "touchmove"]) window.addEventListener(ev, onScroll, { passive: true });
window.addEventListener("hashchange", () => {
  const m = /^#e(\d+)$/.exec(location.hash);
  if (m && S.tl && /^\/t\//.test(location.pathname)) openEntry(Number(m[1]), true);
});

function iso(d) {
  return d.toISOString().slice(0, 10);
}
/** The ISO week of a date: its Monday, its Sunday and its number. */
function weekOf(date) {
  const d = new Date(`${date}T00:00:00Z`);
  const start = new Date(d);
  start.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  const thu = new Date(start);
  thu.setUTCDate(start.getUTCDate() + 3);
  const y = thu.getUTCFullYear();
  const n = 1 + Math.floor((thu - Date.UTC(y, 0, 1)) / 86400000 / 7);
  return { start: iso(start), end: iso(end), n, y };
}
function weekEl(w) {
  const [, m1, d1] = w.start.split("-").map(Number);
  const [y2, m2, d2] = w.end.split("-").map(Number);
  const range =
    m1 === m2
      ? `${d1} to ${d2} ${MONTHS[m2 - 1]} ${y2}`
      : `${d1} ${MONTHS[m1 - 1]} to ${d2} ${MONTHS[m2 - 1]} ${y2}`;
  return h("div", { class: "period" }, h("h2", {}, `Week ${w.n}`), h("div", { class: "era" }, range));
}

function metaEl(e) {
  return h(
    "div",
    { class: "meta" },
    e.fields.decidedBy && e.type === "decision"
      ? h(
          "span",
          {},
          `Decided by ${e.fields.decidedBy.length > 60 ? `${e.fields.decidedBy.slice(0, 58)}…` : e.fields.decidedBy}`,
        )
      : null,
    e.fields.state ? h("span", { class: "tag" }, e.fields.state) : null,
    e.status === "open"
      ? h("span", { class: "tag open" }, "open")
      : e.status === "closed"
        ? h("span", { class: "tag" }, "closed")
        : null,
    e.fields.waitingOn && e.status === "open" ? h("span", {}, `Waits on ${e.fields.waitingOn}`) : null,
    e.stale ? h("span", { class: "tag stale" }, "gone from its source") : null,
    e.comments
      ? h(
          "span",
          { class: "c" },
          `${e.comments} comment${e.comments > 1 ? "s" : ""}${e.openThreads ? `, ${e.openThreads} open` : ""}`,
        )
      : null,
    ...e.tags
      .filter((t) => t !== "v1")
      .slice(0, 4)
      .map((t) => h("span", { class: "tag" }, t)),
  );
}

function entryEl(e, showDate) {
  const open = S.open.has(e.id);
  const el = h("article", {
    class: `entry ${e.type}${open ? " open" : ""}${open && S.active === e.id ? " active" : ""}`,
    id: `e${e.id}`,
  });
  const day = Number(e.date.slice(8));
  el.append(
    ...[
      mk(e.type),
      showDate
        ? h("span", { class: "when", title: e.date }, `${day} ${MONTHS[Number(e.date.slice(5, 7)) - 1]}`)
        : null,
      h(
        "div",
        { class: "line" },
        h("span", { class: "typename" }, TYPE_NAME[e.type]),
        // The title stays the one keyboard stop for the entry (Enter and Space open it); the rest of the card
        // answers pointer clicks and taps the same way.
        h(
          "button",
          {
            class: "title",
            type: "button",
            "aria-expanded": String(open),
            onclick: () => toggle(e.id),
          },
          e.title,
        ),
      ),
      e.summary ? h("p", { class: "summary" }, e.summary) : null,
      metaEl(e),
    ].filter(Boolean),
  );
  el.addEventListener("click", (ev) => {
    if (ev.target.closest("a, button, input, select, textarea, label, summary, details, form, dialog, svg"))
      return;
    if (String(window.getSelection?.() || "").length) return; // selecting text is not a click
    if (ev.target.closest(".detail")) return setActive(e.id);
    toggle(e.id);
  });
  if (open) {
    const d = h("div", { class: "detail" }, h("p", { class: "muted" }, "Loading…"));
    el.append(d);
    fillDetail(e.id, d);
  }
  return el;
}

function toggle(id) {
  const was = S.active;
  if (S.open.has(id)) {
    S.open.delete(id);
    if (S.active === id) S.active = [...S.open].pop() ?? null;
  } else {
    S.open.add(id);
    S.active = id;
  }
  const e = S.byId.get(id);
  const old = document.getElementById(`e${id}`);
  if (old && e) {
    const focused = old.contains(document.activeElement);
    const fresh = entryEl(e, !!old.querySelector(".when"));
    old.replaceWith(fresh);
    if (focused) fresh.querySelector(".title")?.focus();
  }
  if (S.open.has(id)) history.replaceState(null, "", `#e${id}`);
  else if (location.hash === `#e${id}`) history.replaceState(null, "", location.pathname + location.search);
  if (S.active !== was) {
    markActive();
    drawPanel();
  }
}

function setActive(id) {
  if (S.active === id || !S.open.has(id)) return;
  S.active = id;
  history.replaceState(null, "", `#e${id}`);
  markActive();
  drawPanel();
}

function markActive() {
  for (const el of document.querySelectorAll(".entry.active")) el.classList.remove("active");
  if (S.active) document.getElementById(`e${S.active}`)?.classList.add("active");
}

async function openEntry(id, scroll) {
  if (!S.byId.has(id) && !(await load({ until: id }))) return;
  if (!S.byId.has(id)) return;
  if (!S.open.has(id)) toggle(id);
  else setActive(id);
  if (scroll) document.getElementById(`e${id}`)?.scrollIntoView({ block: "start", behavior: "auto" });
}

async function fillDetail(id, box) {
  let e;
  try {
    e = await api("GET", `/api/entries/${id}`);
  } catch (err) {
    box.replaceChildren(h("p", { class: "error" }, err.message));
    return;
  }
  const kids = [];
  const f = e.fields;
  const fh = e.fieldsHtml || {};
  const facts = h("dl", { class: "facts" });
  const fact = (label, node) => node && facts.append(h("dt", {}, label), h("dd", {}, node));
  const md = (html) => (html ? h("div", { class: "md", html }) : null);
  if (e.type === "decision") {
    fact("The question", md(fh.question));
    fact("What was chosen", md(fh.choice));
    fact("Why", md(fh.why));
    fact(
      "Alternatives",
      f.alternatives?.length
        ? h(
            "ul",
            { class: "md" },
            f.alternatives.map((a) => h("li", {}, a)),
          )
        : null,
    );
    fact("Decided by", md(fh.decidedBy));
    fact("State", md(fh.state));
  }
  if (e.type === "finding") fact("What it taught", md(fh.lesson));
  if (e.type === "question") {
    fact("Waits on", md(fh.waitingOn));
    fact("Status", e.status ? document.createTextNode(e.status) : null);
  }
  if (facts.children.length) kids.push(facts);
  if (f.metrics?.length) {
    kids.push(
      h(
        "div",
        { class: "metrics" },
        f.metrics.map((m) =>
          h(
            "div",
            { class: "metric" },
            h(
              "div",
              { class: "v" },
              typeof m.value === "number" ? m.value.toLocaleString("en-GB") : m.value,
              m.unit ? h("small", {}, m.unit) : null,
            ),
            h("div", { class: "l" }, m.label),
            m.note ? h("div", { class: "n" }, m.note) : null,
          ),
        ),
      ),
    );
  }
  if (f.chart?.bars?.length) kids.push(chart(f.chart));
  if (e.bodyHtml) {
    const long = e.bodyHtml.length > 1800 || facts.children.length > 0;
    kids.push(
      long
        ? h(
            "details",
            { class: "body", open: facts.children.length === 0 && e.bodyHtml.length < 6000 },
            h("summary", {}, "The full text"),
            md(e.bodyHtml),
          )
        : md(e.bodyHtml),
    );
  }
  const rel = relations(id);
  if (rel) kids.push(rel);
  const lk = [...(f.links || []), ...(f.sources || [])];
  if (lk.length)
    kids.push(
      h(
        "div",
        { class: "linkrow" },
        h("span", { class: "muted" }, "Sources and links:"),
        lk.map((l) =>
          l.url
            ? h("a", { href: l.url, target: "_blank", rel: "noopener noreferrer" }, l.label)
            : h("span", {}, l.label),
        ),
      ),
    );
  const canEdit = ["edit", "owner"].includes(S.tl.access);
  kids.push(
    h(
      "div",
      { class: "tools muted" },
      e.imported
        ? h(
            "span",
            {},
            e.byHand
              ? "Imported, then edited here: the import leaves it alone."
              : "Imported: the next import refreshes it.",
          )
        : h("span", {}, "Written here."),
      canEdit ? h("button", { class: "linkish", onclick: () => editEntry(e) }, "Edit") : null,
      canEdit
        ? h("button", { class: "linkish", onclick: () => linkDialog(e) }, "Link to another entry")
        : null,
      canEdit && e.imported && e.byHand
        ? h(
            "button",
            {
              class: "linkish",
              onclick: async () => (await api("PATCH", `/api/entries/${e.id}`, { byHand: false }), refresh()),
            },
            "Follow the source again",
          )
        : null,
      canEdit && (!e.imported || e.stale)
        ? h(
            "button",
            {
              class: "linkish danger",
              onclick: async () => {
                if (!confirm(`Delete "${e.title}"?`)) return;
                try {
                  await api("DELETE", `/api/entries/${e.id}`);
                  S.open.delete(e.id);
                  refresh();
                } catch (err) {
                  alert(err.message);
                }
              },
            },
            "Delete",
          )
        : null,
      h(
        "a",
        {
          href: `#e${e.id}`,
          onclick: (ev) => (
            ev.preventDefault(),
            navigator.clipboard?.writeText(`${location.origin}${location.pathname}#e${e.id}`)?.catch(() => {})
          ),
        },
        "Copy link",
      ),
    ),
  );
  kids.push(h("div", { class: "thread-slot" }));
  box.replaceChildren(...kids);
  if (S.active === id) placePanel();
}

function relations(id) {
  const rows = [];
  for (const l of S.links) {
    if (l.from_id === id && S.linked.has(l.to_id))
      rows.push([LINK_WORDS[l.kind][0], S.linked.get(l.to_id), l]);
    if (l.to_id === id && S.linked.has(l.from_id))
      rows.push([LINK_WORDS[l.kind][1], S.linked.get(l.from_id), l]);
  }
  if (!rows.length) return null;
  rows.sort((a, b) => a[1].date.localeCompare(b[1].date));
  const canEdit = ["edit", "owner"].includes(S.tl.access);
  return h(
    "div",
    { class: "rel" },
    rows.map(([word, other, l]) =>
      h(
        "div",
        { class: other.type },
        h("span", { class: "k" }, word),
        h(
          "a",
          { href: `#e${other.id}`, onclick: (ev) => (ev.preventDefault(), openEntry(other.id, true)) },
          mk(other.type),
          `${other.title}`,
        ),
        h("span", { class: "muted mono" }, ` ${other.date}`),
        canEdit && !l.imported
          ? h(
              "button",
              {
                class: "linkish danger",
                style: "margin-left:8px",
                onclick: async () => (await api("DELETE", `/api/links/${l.id}`), refresh()),
              },
              "unlink",
            )
          : null,
      ),
    ),
  );
}

function chart(c) {
  const bars = c.bars;
  const max = Math.max(...bars.map((b) => b.value), 1);
  const tip = h("div", { class: "tip", "aria-live": "polite" }, " ");
  const fmt = (v) => `${v.toLocaleString("en-GB")}${c.unit ? ` ${c.unit}` : ""}`;
  const NS = "http://www.w3.org/2000/svg";
  const s = (tag, attrs, text) => {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    if (text != null) el.textContent = text;
    return el;
  };
  let svg;
  if (bars.length <= 10) {
    // horizontal bars, each labelled with its value
    const W = 640;
    const rowH = 26;
    const labelW = 190;
    const H = bars.length * rowH;
    svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": c.title });
    bars.forEach((b, i) => {
      const w = Math.max(2, ((W - labelW - 90) * b.value) / max);
      const y = i * rowH + 4;
      svg.append(s("text", { x: labelW - 8, y: y + 13, "text-anchor": "end" }, b.label));
      const r = s("rect", { class: "b", x: labelW, y, width: w, height: rowH - 10, rx: 2 });
      r.addEventListener("mouseenter", () => (tip.textContent = `${b.label}: ${fmt(b.value)}`));
      svg.append(r, s("text", { class: "v", x: labelW + w + 6, y: y + 13 }, fmt(b.value)));
    });
  } else {
    // columns over time; the label under every few columns, the value on hover
    const W = 640;
    const H = 150;
    const gap = 2;
    const cw = (W - 30) / bars.length;
    svg = s("svg", { viewBox: `0 0 ${W} ${H + 20}`, role: "img", "aria-label": c.title });
    svg.append(
      s("line", { class: "axis", x1: 30, x2: W, y1: H, y2: H }),
      s("text", { x: 26, y: 10, "text-anchor": "end" }, String(max)),
      s("text", { x: 26, y: H, "text-anchor": "end" }, "0"),
    );
    const every = Math.ceil(bars.length / 8);
    bars.forEach((b, i) => {
      const hgt = (H - 12) * (b.value / max);
      const x = 30 + i * cw + gap / 2;
      const r = s("rect", {
        class: "b",
        x,
        y: H - hgt,
        width: Math.max(1, cw - gap),
        height: Math.max(0, hgt),
        rx: 2,
      });
      const hit = s("rect", { x: 30 + i * cw, y: 0, width: cw, height: H, fill: "transparent" });
      const on = () => {
        tip.textContent = `${b.label}: ${fmt(b.value)}`;
        r.classList.add("hl");
      };
      const off = () => r.classList.remove("hl");
      hit.addEventListener("mouseenter", on);
      hit.addEventListener("mouseleave", off);
      svg.append(r, hit);
      if (i % every === 0)
        svg.append(s("text", { x: x + cw / 2, y: H + 14, "text-anchor": "middle" }, b.label));
    });
  }
  const table = h(
    "details",
    {},
    h("summary", {}, "As a table"),
    h(
      "table",
      {},
      bars.map((b) => h("tr", {}, h("td", {}, b.label), h("td", { class: "mono" }, fmt(b.value)))),
    ),
  );
  return h("div", { class: "chart" }, h("h4", {}, c.title), svg, tip, table);
}

// --- threads --------------------------------------------------------------------------------------------------
// The threads of the active entry, as a chat: a pane beside the timeline on wide screens, under the entry on
// narrow ones. Each thread is its first comment with its replies indented under it; the box to write sits last.
function drawPanel() {
  const id = S.active;
  const e = id ? S.byId.get(id) : null;
  if (!S.panel) return;
  if (!e) {
    S.panel.replaceChildren(
      h(
        "div",
        { class: "chat-empty" },
        h("h3", {}, "Threads"),
        h("p", { class: "muted" }, "Open an entry to read its threads and write in them."),
      ),
    );
    placePanel();
    return;
  }
  const log = h("div", { class: "chat-log", role: "log" }, h("p", { class: "muted" }, "Loading…"));
  const foot = h("div", { class: "chat-foot" });
  S.panel.replaceChildren(
    h(
      "div",
      { class: `chat-head ${e.type}` },
      mk(e.type),
      h(
        "div",
        {},
        h("span", { class: "typename" }, `Threads on this ${TYPE_NAME[e.type].toLowerCase()}`),
        h(
          "a",
          {
            href: `#e${e.id}`,
            onclick: (ev) => (
              ev.preventDefault(),
              document.getElementById(`e${e.id}`)?.scrollIntoView({ block: "start", behavior: "smooth" })
            ),
          },
          e.title,
        ),
      ),
    ),
    log,
    foot,
  );
  placePanel();
  drawThreads({ entryId: id, log, foot });
}

function placePanel() {
  const side = document.querySelector(".side");
  if (!S.panel || !side) return;
  const slot = S.active ? document.querySelector(`#e${S.active} .thread-slot`) : null;
  const home = WIDE.matches || !slot ? side : slot;
  if (S.panel.parentNode !== home) home.append(S.panel);
}

async function drawThreads(ctx) {
  const { entryId, log, foot } = ctx;
  let data;
  try {
    data = await api("GET", `/api/entries/${entryId}/comments`);
  } catch (e) {
    log.replaceChildren(h("p", { class: "error" }, e.message));
    return;
  }
  if (S.active !== entryId || !log.isConnected) return;
  ctx.may = data.mayComment;
  const tops = data.comments.filter((c) => !c.parentId);
  const kids = [];
  for (const t of tops) {
    const replies = data.comments.filter((c) => c.parentId === t.id);
    const th = h("div", { class: `thread${t.resolvedAt ? " resolved" : ""}` });
    const body = () => {
      th.replaceChildren(bubble(t, ctx, true));
      if (replies.length)
        th.append(
          h(
            "div",
            { class: "replies" },
            replies.map((r) => bubble(r, ctx, false)),
          ),
        );
      if (ctx.may && !t.resolvedAt) th.append(replyButton(ctx, t.id));
    };
    if (t.resolvedAt) {
      th.append(
        h(
          "p",
          { class: "muted resolved-line" },
          `${t.author.name}: resolved by ${t.resolvedBy || "someone"} ${ago(t.resolvedAt)} (${replies.length + 1} comment${replies.length ? "s" : ""}) `,
          h("button", { class: "linkish", type: "button", onclick: body }, "Show"),
        ),
      );
    } else body();
    kids.push(th);
  }
  if (!tops.length)
    kids.push(
      h(
        "p",
        { class: "muted chat-none" },
        ctx.may
          ? "No threads yet. Start one below."
          : "No threads. You may read this timeline, not comment on it.",
      ),
    );
  log.replaceChildren(...kids);
  foot.replaceChildren(ctx.may ? composer(ctx, null, "Send") : "");
  foot.hidden = !ctx.may;
  if (WIDE.matches) log.scrollTop = log.scrollHeight;
}

function bubble(c, ctx, top) {
  const el = h("div", { class: `bubble${c.mine ? " mine" : ""}` });
  const redraw = () => drawThreads(ctx).then(() => refreshCounts(ctx.entryId));
  const acts = h(
    "div",
    { class: "acts" },
    ctx.may && top && !c.deleted
      ? h(
          "button",
          {
            class: "linkish",
            type: "button",
            onclick: async () => (
              await api("PATCH", `/api/comments/${c.id}`, { resolved: !c.resolvedAt }), redraw()
            ),
          },
          c.resolvedAt ? "Reopen" : "Resolve",
        )
      : null,
    c.mine && !c.deleted
      ? h(
          "button",
          { class: "linkish", type: "button", onclick: () => el.replaceWith(composer(ctx, null, "Save", c)) },
          "Edit",
        )
      : null,
    (c.mine || S.tl.access === "owner") && !c.deleted
      ? h(
          "button",
          {
            class: "linkish danger",
            type: "button",
            onclick: async () =>
              confirm("Remove this comment?") && (await api("DELETE", `/api/comments/${c.id}`), redraw()),
          },
          "Remove",
        )
      : null,
  );
  el.append(
    h(
      "div",
      { class: "by" },
      h("b", {}, c.mine ? "You" : c.author.name),
      h("span", { class: "t", title: c.createdAt }, ago(c.createdAt), c.editedAt ? " · edited" : ""),
    ),
    c.deleted ? h("p", { class: "muted gone" }, "Removed.") : h("div", { class: "md", html: c.bodyHtml }),
    acts.children.length ? acts : null,
  );
  return el;
}

function replyButton(ctx, parentId) {
  const b = h(
    "button",
    {
      class: "linkish reply",
      type: "button",
      onclick: () => {
        const f = composer(ctx, parentId, "Reply");
        b.replaceWith(f);
        f.querySelector("textarea").focus();
      },
    },
    "Reply",
  );
  return b;
}

function composer(ctx, parentId, verb, editing) {
  const ta = h("textarea", {
    placeholder: parentId
      ? "Your reply"
      : editing
        ? ""
        : "Write a comment. Markdown works; @username mentions someone.",
    required: true,
    rows: 2,
    "aria-label": parentId ? "Your reply" : editing ? "Your comment" : "A new thread",
  });
  if (editing) ta.value = editing.body || "";
  const err = h("span", { class: "error" });
  const f = h(
    "form",
    { class: `composer${parentId ? " inline" : ""}` },
    ta,
    h(
      "div",
      { class: "row" },
      h("button", { class: "button small", type: "submit" }, verb),
      editing || parentId
        ? h("button", { class: "linkish", type: "button", onclick: () => drawThreads(ctx) }, "Cancel")
        : h("span", {}, "Ctrl+Enter sends"),
      err,
    ),
  );
  ta.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      f.requestSubmit();
    }
  });
  f.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try {
      if (editing) await api("PATCH", `/api/comments/${editing.id}`, { body: ta.value });
      else await api("POST", `/api/entries/${ctx.entryId}/comments`, { body: ta.value, parentId });
      await drawThreads(ctx);
      refreshCounts(ctx.entryId);
    } catch (e) {
      err.textContent = e.message;
    }
  });
  return f;
}

async function refreshCounts(id) {
  const fresh = await api("GET", `/api/entries/${id}`).catch(() => null);
  const e = S.byId.get(id);
  if (!fresh || !e) return;
  Object.assign(e, { comments: fresh.comments, openThreads: fresh.openThreads });
  document.querySelector(`#e${id} > .meta`)?.replaceWith(metaEl(e));
}

function refresh() {
  return timeline(S.tl.slug, true);
}

// --- dialogs --------------------------------------------------------------------------------------------------
function dialog(title, body, onSubmit, extraFoot) {
  const err = h("p", { class: "error" });
  const d = h("dialog", {});
  const form = h(
    "form",
    { method: "dialog" },
    h("h2", {}, title),
    body,
    err,
    h(
      "div",
      { class: "foot" },
      h(
        "div",
        { class: "tools" },
        h("button", { class: "button", type: "submit" }, "Save"),
        h("button", { class: "linkish", type: "button", onclick: () => d.close() }, "Cancel"),
      ),
      extraFoot,
    ),
  );
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try {
      await onSubmit(new FormData(form));
      d.close();
    } catch (e) {
      err.textContent = e.message;
    }
  });
  d.append(form);
  d.addEventListener("close", () => d.remove());
  document.body.append(d);
  d.showModal();
  return d;
}

const field = (label, input, hint) =>
  h("label", { class: "field" }, label, hint ? h("small", {}, hint) : null, input);
const ta = (name, value, rows = 4) => h("textarea", { name, rows }, value || "");
const inp = (name, value, attrs = {}) => h("input", { type: "text", name, value: value ?? "", ...attrs });

function editEntry(e) {
  const f = e?.fields || {};
  const type = h(
    "select",
    { name: "type" },
    TYPES.map(([k, n]) => h("option", { value: k, selected: (e?.type || "decision") === k }, n)),
  );
  const parts = {
    decision: [
      field("The question", ta("question", f.question, 3)),
      field("What was chosen", ta("choice", f.choice, 4)),
      field("Why", ta("why", f.why, 3)),
      field("Alternatives", ta("alternatives", (f.alternatives || []).join("\n"), 3), "One per line"),
      field("Decided by", inp("decidedBy", f.decidedBy)),
      field("State", inp("state", f.state, { placeholder: "in force, done, retired…" })),
    ],
    result: [
      field(
        "Numbers",
        ta(
          "metrics",
          (f.metrics || []).map((m) => `${m.label}: ${m.value}${m.unit ? ` ${m.unit}` : ""}`).join("\n"),
          4,
        ),
        "One per line, as label: value unit. Counts and rates only, never a person's data.",
      ),
      field("Chart title", inp("chartTitle", f.chart?.title)),
      field(
        "Chart bars",
        ta("chart", (f.chart?.bars || []).map((b) => `${b.label}: ${b.value}`).join("\n"), 4),
        "One per line, as label: number",
      ),
      field("Chart unit", inp("chartUnit", f.chart?.unit)),
    ],
    finding: [field("What it taught", ta("lesson", f.lesson, 3))],
    question: [
      field("Waits on", inp("waitingOn", f.waitingOn, { placeholder: "a person, a result, a date" })),
      field(
        "Status",
        h(
          "select",
          { name: "status" },
          ["open", "closed"].map((s) => h("option", { value: s, selected: (e?.status || "open") === s }, s)),
        ),
      ),
    ],
  };
  const typed = h("div", { style: "display:grid;gap:12px" });
  const showTyped = () => typed.replaceChildren(...(parts[type.value] || []));
  type.addEventListener("change", showTyped);
  showTyped();
  const body = h(
    "div",
    { style: "display:grid;gap:12px" },
    h(
      "div",
      { class: "grid2" },
      field("Type", type),
      field(
        "Date",
        h("input", {
          type: "date",
          name: "date",
          required: true,
          value: e?.date || new Date().toISOString().slice(0, 10),
        }),
      ),
    ),
    field("Title", inp("title", e?.title, { required: true, maxlength: 300 })),
    field("Summary", ta("summary", e?.summary, 2), "A sentence or two, shown in the line"),
    typed,
    field("Text", ta("body", e?.body, 6), "Markdown"),
    field(
      "Links",
      ta(
        "links",
        [...(f.links || []), ...(f.sources || [])].map((l) => `${l.label} | ${l.url || ""}`).join("\n"),
        3,
      ),
      "One per line, as label | https://…  (pull requests, releases, studies)",
    ),
    field("Tags", inp("tags", (e?.tags || []).join(", ")), "Comma separated, such as record 40"),
    e?.imported && !e.byHand
      ? h(
          "p",
          { class: "muted", style: "font-size:13px" },
          "This entry was imported. Saving an edit keeps your version: later imports leave it alone.",
        )
      : null,
  );
  dialog(e ? "Edit the entry" : "Add an entry", body, async (fd) => {
    const t = fd.get("type");
    const fields = {};
    const str = (k) => (fd.get(k) || "").toString().trim();
    if (t === "decision") {
      for (const k of ["question", "choice", "why", "decidedBy", "state"]) if (str(k)) fields[k] = str(k);
      const alts = lines(str("alternatives"));
      if (alts.length) fields.alternatives = alts;
    }
    if (t === "result") {
      const m = pairs(str("metrics"), ":").map(([label, rest]) => {
        const mm = /^(-?[\d.,]+)\s*(.*)$/.exec(rest);
        return mm
          ? { label, value: Number(mm[1].replace(/,/g, "")), unit: mm[2] || undefined }
          : { label, value: rest };
      });
      if (m.length) fields.metrics = m;
      const bars = pairs(str("chart"), ":")
        .map(([label, v]) => ({ label, value: Number(v.replace(/,/g, "")) }))
        .filter((b) => Number.isFinite(b.value));
      if (bars.length)
        fields.chart = { title: str("chartTitle") || "Chart", unit: str("chartUnit") || undefined, bars };
    }
    if (t === "finding" && str("lesson")) fields.lesson = str("lesson");
    if (t === "question" && str("waitingOn")) fields.waitingOn = str("waitingOn");
    const links = pairs(str("links"), "|").map(([label, url]) => (url ? { label, url } : { label }));
    if (links.length) fields.links = links.filter((l) => l.url);
    const src = links.filter((l) => !l.url);
    if (src.length) fields.sources = src;
    const payload = {
      type: t,
      date: str("date"),
      title: str("title"),
      summary: str("summary"),
      body: str("body"),
      tags: str("tags")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
      fields,
      status: t === "question" ? str("status") || "open" : "",
    };
    if (e) {
      await api("PATCH", `/api/entries/${e.id}`, payload);
    } else {
      const r = await api("POST", `/api/timelines/${S.tl.slug}/entries`, payload);
      S.open.add(r.id);
      S.active = r.id;
      history.replaceState(null, "", `#e${r.id}`);
    }
    await refresh();
  });
}

async function linkDialog(e) {
  const all = await api("GET", `/api/timelines/${S.tl.slug}/entries?brief=1`).catch(() => ({ entries: [] }));
  const others = all.entries.filter((x) => x.id !== e.id);
  const list = h(
    "datalist",
    { id: "entry-list" },
    others.map((x) => h("option", { value: `${x.date} ${x.title} #${x.id}` })),
  );
  const body = h(
    "div",
    { style: "display:grid;gap:12px" },
    field(
      "This entry",
      h(
        "select",
        { name: "kind" },
        Object.entries(LINK_WORDS).map(([k, [w]]) => h("option", { value: k }, w.toLowerCase())),
      ),
    ),
    field(
      "The other entry",
      h("input", {
        type: "text",
        name: "to",
        list: "entry-list",
        required: true,
        placeholder: "Type to search by date or title",
      }),
      "Pick from the list",
    ),
    list,
  );
  dialog(`Link "${e.title}"`, body, async (fd) => {
    const m = /#(\d+)$/.exec(String(fd.get("to")));
    if (!m) throw new Error("pick an entry from the list");
    await api("POST", `/api/entries/${e.id}/links`, { to: Number(m[1]), kind: fd.get("kind") });
    await refresh();
  });
}

function editPicture() {
  const p = S.tl.picture;
  const body = h(
    "div",
    { class: "picture-edit" },
    field("Where we are", ta("now", p.now, 5), "Markdown"),
    field("What is next", ta("next", p.next, 5)),
    field("Waiting on", ta("waiting", p.waiting, 4), "Open questions are listed under it on their own"),
    p.byHand
      ? h("label", {}, h("input", { type: "checkbox", name: "follow" }), " Let the import write it again")
      : h(
          "p",
          { class: "muted", style: "font-size:13px" },
          "Saving keeps your text; later imports leave it alone.",
        ),
  );
  dialog("The big picture", body, async (fd) => {
    await api("PATCH", `/api/timelines/${S.tl.slug}`, {
      picture: {
        now: fd.get("now") || "",
        next: fd.get("next") || "",
        waiting: fd.get("waiting") || "",
        byHand: !fd.get("follow"),
      },
    });
    await refresh();
  });
}

function share() {
  let grants = [...(S.tl.grants || [])];
  const box = h("div", { class: "grants" });
  const users = h(
    "datalist",
    { id: "dir-users" },
    (S.dir?.users || []).map((u) => h("option", { value: u.username }, u.name)),
  );
  const groups = h(
    "datalist",
    { id: "dir-groups" },
    (S.dir?.groups || []).map((g) => h("option", { value: g })),
  );
  const draw = () => {
    box.replaceChildren(
      ...grants.map((g, i) => {
        const kind = h(
          "select",
          {},
          [
            ["user", "a person"],
            ["group", "a group"],
            ["all", "everyone signed in"],
          ].map(([k, n]) => h("option", { value: k, selected: g.kind === k }, n)),
        );
        const name = h("input", {
          type: "text",
          value: g.kind === "all" ? "" : g.name,
          list: g.kind === "group" ? "dir-groups" : "dir-users",
          disabled: g.kind === "all",
          placeholder: g.kind === "group" ? "group" : "username",
        });
        const level = h(
          "select",
          {},
          [
            ["view", "may view"],
            ["comment", "may comment"],
            ["edit", "may edit"],
          ].map(([k, n]) => h("option", { value: k, selected: g.level === k }, n)),
        );
        kind.addEventListener("change", () => ((g.kind = kind.value), draw()));
        name.addEventListener("input", () => (g.name = name.value));
        level.addEventListener("change", () => (g.level = level.value));
        return h(
          "div",
          { class: "grant" },
          kind,
          name,
          level,
          h(
            "button",
            { class: "linkish danger", type: "button", onclick: () => (grants.splice(i, 1), draw()) },
            "remove",
          ),
        );
      }),
    );
    if (!grants.length)
      box.append(
        h(
          "p",
          { class: "muted", style: "font-size:14px" },
          "Shared with nobody: only you and the administrators see it.",
        ),
      );
  };
  draw();
  const body = h(
    "div",
    { style: "display:grid;gap:12px" },
    h(
      "p",
      { class: "muted", style: "font-size:14px" },
      "Administrators see every timeline. Commenting includes viewing, and editing includes both.",
    ),
    box,
    h(
      "button",
      {
        class: "button ghost small",
        type: "button",
        style: "justify-self:start",
        onclick: () => (grants.push({ kind: "user", name: "", level: "view" }), draw()),
      },
      "Add someone",
    ),
    users,
    groups,
  );
  dialog("Who sees it", body, async () => {
    grants = grants
      .map((g) => ({ ...g, name: g.kind === "all" ? "*" : g.name.trim() }))
      .filter((g) => g.name);
    await api("PUT", `/api/timelines/${S.tl.slug}/grants`, { grants });
    await refresh();
  });
}

function settings() {
  const body = h(
    "div",
    { style: "display:grid;gap:12px" },
    field("Name", inp("title", S.tl.title, { required: true })),
    field("What it follows", ta("summary", S.tl.summary, 2)),
    field(
      "Hand it to",
      inp("owner", "", { list: "dir-users2", placeholder: "username (they must have signed in once)" }),
    ),
    h(
      "datalist",
      { id: "dir-users2" },
      (S.dir?.users || []).map((u) => h("option", { value: u.username }, u.name)),
    ),
  );
  const del = h(
    "button",
    {
      class: "linkish danger",
      type: "button",
      onclick: async () => {
        if (
          !confirm(
            `Delete the timeline "${S.tl.title}" with every entry and thread in it? This cannot be undone.`,
          )
        )
          return;
        await api("DELETE", `/api/timelines/${S.tl.slug}`);
        document.querySelector("dialog")?.close();
        history.pushState(null, "", "/");
        route();
      },
    },
    "Delete the timeline",
  );
  dialog(
    "Settings",
    body,
    async (fd) => {
      const b = { title: fd.get("title"), summary: fd.get("summary") };
      if (fd.get("owner")) b.owner = fd.get("owner");
      await api("PATCH", `/api/timelines/${S.tl.slug}`, b);
      await refresh();
    },
    del,
  );
}

boot().catch((e) =>
  main.replaceChildren(h("p", { class: "error pad" }, `Munin could not start: ${e.message}`)),
);
