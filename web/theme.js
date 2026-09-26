// SPDX-License-Identifier: AGPL-3.0-only
// Applied before the page paints, so a chosen theme never flashes the other one.
try {
  const t = localStorage.getItem("munin-theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch {}
