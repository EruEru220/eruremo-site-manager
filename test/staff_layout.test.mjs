import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const HTML_PATH = new URL("../eruremo_SiteManager.html", import.meta.url);
const HTML = readFileSync(HTML_PATH, "utf8");

const cssMatch = /const STAFF_LAYOUT_CSS=`([\s\S]*?)`;/u.exec(HTML);
assert.ok(cssMatch, "staff layout CSS override is missing");
const STAFF_CSS = cssMatch[1];

const templateMatch = /const TEMPLATE = decodeB64\("([^"]+)"\);/u.exec(HTML);
assert.ok(templateMatch, "generated-site template is missing");
const TEMPLATE = Buffer.from(templateMatch[1], "base64").toString("utf8");

function cssRule(selector){
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "u").exec(STAFF_CSS);
  assert.ok(match, `CSS rule is missing: ${selector}`);
  return match[1].replace(/\s+/g, "");
}

test("odd staff rows allocate 40 percent to image and 60 percent to text", () => {
  const rule = cssRule(".staff-row");
  assert.match(rule, /grid-template-columns:minmax\(0,2fr\)minmax\(0,3fr\)/u);
  assert.match(rule, /grid-template-areas:"photoinfo"/u);
});

test("even staff rows mirror the same 40/60 allocation", () => {
  const rule = cssRule(".staff-row.flip");
  assert.match(rule, /grid-template-columns:minmax\(0,3fr\)minmax\(0,2fr\)/u);
  assert.match(rule, /grid-template-areas:"infophoto"/u);
});

test("photo and text keep stable shared sizing in either direction", () => {
  assert.match(STAFF_CSS, /\.staff-row \.s-photo-col,\s*\.staff-row\.flip \.s-photo-col\s*\{[\s\S]*?grid-area:photo;[\s\S]*?order:0;[\s\S]*?width:100%;[\s\S]*?max-width:320px;/u);
  assert.match(STAFF_CSS, /\.staff-row \.s-info,\s*\.staff-row\.flip \.s-info\s*\{[\s\S]*?grid-area:info;[\s\S]*?order:0;[\s\S]*?min-width:0;[\s\S]*?width:100%;/u);
});

test("staff photos preserve a bounded 3:4 crop without stretching", () => {
  assert.match(STAFF_CSS, /\.staff-row \.s-photo,\s*\.staff-row \.s-ph\s*\{[\s\S]*?width:100%;[\s\S]*?aspect-ratio:3\/4;/u);
  assert.match(cssRule(".staff-row .s-photo"), /object-fit:cover;/u);
  assert.match(cssRule(".staff-row .s-photo"), /object-position:center;/u);
  assert.match(TEMPLATE, /el\("figure","polaroid s-photo-col"\)/u);
  assert.match(TEMPLATE, /el\("span","tape "\+/u);
});

test("mobile staff rows use one consistent image-then-text column", () => {
  const mobile = /@media \(max-width:680px\)\{([\s\S]*?)\n\}/u.exec(STAFF_CSS);
  assert.ok(mobile, "staff mobile breakpoint is missing");
  assert.match(mobile[1], /\.staff-row,\s*\.staff-row\.flip\s*\{[\s\S]*?grid-template-columns:minmax\(0,1fr\);[\s\S]*?grid-template-areas:"photo" "info";/u);
  assert.match(mobile[1], /max-width:min\(78vw,260px\);/u);
});

test("staff alternation stays generic for any number of members", () => {
  assert.match(TEMPLATE, /members\)\|\|\[\]\)\.forEach\(\(m,i\)=>\{/u);
  assert.match(TEMPLATE, /"staff-row reveal"\+\(i%2\?" flip":""\)/u);
  assert.doesNotMatch(STAFF_CSS, /nth-child\([12]\)|data-name|staff-name=/u);
});

test("generated HTML and editor preview both receive the shared staff CSS", () => {
  assert.match(HTML, /let out=injectStaffLayoutCss\(TEMPLATE\);/u);
  assert.match(HTML, /const html=\(await buildHtml\(\)\)\.replace/u);

  const generated = TEMPLATE.replace("</head>", `${STAFF_CSS}</head>`);
  assert.match(generated, /id="staff-layout-balance"/u);
  assert.ok(generated.indexOf("staff-layout-balance") < generated.indexOf("</head>"));
});

const productionJsonPath = process.env.ERUREMO_PRODUCTION_JSON;
test("existing production staff JSON remains backward compatible and read-only", {
  skip: !productionJsonPath
}, () => {
  const before = readFileSync(productionJsonPath);
  const project = JSON.parse(before.toString("utf8"));
  assert.ok(Array.isArray(project.staff?.members));
  assert.ok(project.staff.members.length >= 2);

  const migrateMatch = /function migrate\(d\)\{[\s\S]*?\n\}/u.exec(HTML);
  assert.ok(migrateMatch, "migrate() is missing");
  const migrate = new Function(`${migrateMatch[0]}; return migrate;`)();
  const clone = JSON.parse(JSON.stringify(project));
  const staffBefore = JSON.parse(JSON.stringify(clone.staff.members));

  migrate(clone);
  assert.deepEqual(clone.staff.members, staffBefore);
  assert.deepEqual(readFileSync(productionJsonPath), before);
});
