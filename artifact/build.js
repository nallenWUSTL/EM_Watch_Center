#!/usr/bin/env node
/* Assembles artifact/briefing-watch.html, the claude.ai Artifact page for the
   Daily Intelligence Briefing, from the files the dashboard tab also uses:
     artifact/template.html   page frame, dark-theme tokens, db wiring
     css/briefing.css         component styles (inlined; the Artifact CSP
                              allows no external stylesheets)
     js/briefing-render.js    markup builders (inlined for the same reason)
   Run `node artifact/build.js`, then republish artifact/briefing-watch.html
   to the existing artifact URL (see data/README.md). */
const fs = require("fs");
const path = require("path");
const root = path.resolve(__dirname, "..");
const read = p => fs.readFileSync(path.join(root, p), "utf8");

const css = read("css/briefing.css");
const js = read("js/briefing-render.js");
if (/<\/style/i.test(css)) throw new Error("css/briefing.css must not contain </style>");
if (/<\/script/i.test(js)) throw new Error("js/briefing-render.js must not contain </script>");

const out = read("artifact/template.html")
  .replace("/*__BRIEFING_CSS__*/", () => css.trim())
  .replace("//__BRIEFING_RENDER__", () => js.trim());
if (out.includes("__BRIEFING_")) throw new Error("a placeholder was not replaced");

const target = path.join(root, "artifact/briefing-watch.html");
fs.writeFileSync(target, out);
console.log("wrote artifact/briefing-watch.html (" + out.length + " bytes)");
