/**
 * Seeds the "messy ERP" eval database: a legacy-style schema where the names
 * say little, codes stand for states, money is in cents, one table keeps
 * dates as yyyymmdd integers, nothing declares a foreign key, and a stale
 * import table looks like the real customer table. It exists to measure what
 * the Improver's knowledge book adds; the clean shop fixture leaves no room.
 *
 *   BOOT_PASSWORD=<password the service was created with> npx tsx eval/messy/seed.ts
 *
 * Rerunnable. On the first run it rotates the admin password and creates a
 * read-only `kakaw_reader`; both URLs go to eval/.env.messy (gitignored),
 * never to stdout. The data is generated from a fixed seed, so the gold
 * answers in cases.ts never move.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const HOST = process.env.MESSY_HOST || "46.4.96.211";
const PORT = Number(process.env.MESSY_PORT || 54332);
const DB = "erp";
const ENV_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", ".env.messy");

function readEnv(): Record<string, string> {
  if (!existsSync(ENV_PATH)) return {};
  return Object.fromEntries(
    readFileSync(ENV_PATH, "utf8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]),
  );
}

// ── deterministic data ─────────────────────────────────────────────────────
let state = 20261128;
function rand() {
  // mulberry32
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
const pick = <T>(items: readonly T[]) => items[Math.floor(rand() * items.length)];
function weighted<T>(pairs: ReadonlyArray<readonly [T, number]>): T {
  const total = pairs.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = rand() * total;
  for (const [value, weight] of pairs) {
    roll -= weight;
    if (roll <= 0) return value;
  }
  return pairs[pairs.length - 1][0];
}
const DAY = 86_400_000;
const START = Date.UTC(2024, 0, 1);
const END = Date.UTC(2025, 11, 31);
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const yyyymmdd = (ms: number) => Number(isoDate(ms).replaceAll("-", ""));

const FIRST = ["Omar", "Lina", "Karim", "Sara", "Youssef", "Mona", "Hany", "Dina", "Tarek", "Nour", "Ali", "Rana", "Samir", "Hala", "Adel", "Yara"];
const LAST = ["Haddad", "Mansour", "Saleh", "Fahmy", "Nasser", "Khalil", "Rizk", "Sabry", "Gaber", "Wahba"];
const COMPANY_A = ["Delta", "Nile", "Cairo", "Atlas", "Orion", "Lotus", "Pyramid", "Sinai", "Falcon", "Cedar", "Oasis", "Zenith"];
const COMPANY_B = ["Trading", "Supplies", "Retail", "Group", "Stores", "Mart", "Distribution", "Partners"];
const CITIES = ["Cairo", "Alexandria", "Giza", "Mansoura", "Tanta", "Aswan", "Luxor", "Suez"];

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};

tables.ref_rgn = [
  { rgn_cd: "N", rgn_desc: "North" },
  { rgn_cd: "S", rgn_desc: "South" },
  { rgn_cd: "E", rgn_desc: "East" },
  { rgn_cd: "W", rgn_desc: "West" },
  { rgn_cd: "C", rgn_desc: "Central" },
];

tables.ref_cat = [
  { cat_id: 1, cat_nm: "Electronics", prnt_cat_id: null },
  { cat_id: 2, cat_nm: "Home", prnt_cat_id: null },
  { cat_id: 3, cat_nm: "Office", prnt_cat_id: null },
  { cat_id: 11, cat_nm: "Phones", prnt_cat_id: 1 },
  { cat_id: 12, cat_nm: "Laptops", prnt_cat_id: 1 },
  { cat_id: 13, cat_nm: "Accessories", prnt_cat_id: 1 },
  { cat_id: 21, cat_nm: "Kitchen", prnt_cat_id: 2 },
  { cat_id: 22, cat_nm: "Furniture", prnt_cat_id: 2 },
  { cat_id: 31, cat_nm: "Paper", prnt_cat_id: 3 },
  { cat_id: 32, cat_nm: "Writing", prnt_cat_id: 3 },
];

// One generic code table, the way old ERPs do it. Only order statuses live here.
tables.ref_sts = [
  { dom: "ORD", cd: 10, dsc: "New" },
  { dom: "ORD", cd: 20, dsc: "Paid" },
  { dom: "ORD", cd: 30, dsc: "Shipped" },
  { dom: "ORD", cd: 40, dsc: "Delivered" },
  { dom: "ORD", cd: 90, dsc: "Cancelled" },
];

tables.ref_dept = [
  { dept_cd: "SLS", dept_nm: "Sales" },
  { dept_cd: "OPS", dept_nm: "Operations" },
  { dept_cd: "FIN", dept_nm: "Finance" },
  { dept_cd: "WH", dept_nm: "Warehouse" },
];

// Employees: four department heads (1-4), then staff who report to them or to a team lead.
tables.emp_mst = [];
const depts = ["SLS", "OPS", "FIN", "WH"];
for (let emp = 1; emp <= 40; emp += 1) {
  const dept = emp <= 4 ? depts[emp - 1] : emp <= 24 ? "SLS" : pick(["OPS", "FIN", "WH"]);
  const manager = emp <= 4 ? null : dept === "SLS" ? (emp <= 8 ? 1 : pick([1, 5, 6, 7, 8])) : depts.indexOf(dept) + 1;
  const hired = START - int(30, 2500) * DAY;
  const terminated = emp > 4 && rand() < 0.15 ? isoDate(START + int(30, 600) * DAY) : null;
  tables.emp_mst.push({
    emp_no: 1000 + emp,
    f_nm: pick(FIRST),
    l_nm: pick(LAST),
    dept_cd: dept,
    mgr_emp_no: manager === null ? null : 1000 + manager,
    hire_dt: isoDate(hired),
    term_dt: terminated,
  });
}
const salesReps = tables.emp_mst.filter((row) => row.dept_cd === "SLS").map((row) => row.emp_no as number);

// Customers. 1 is the internal test account.
tables.tbl_cst = [];
tables.cst_addr = [];
for (let id = 1; id <= 400; id += 1) {
  const created = START - int(0, 700) * DAY + int(0, 500) * DAY;
  tables.tbl_cst.push({
    cst_id: id,
    cst_nm: id === 1 ? "TEST ACCOUNT - DO NOT USE" : `${pick(COMPANY_A)} ${pick(COMPANY_B)} ${id}`,
    cst_typ: id === 1 ? 1 : weighted([[1, 55], [2, 30], [3, 15]] as const),
    rgn_cd: weighted([["N", 30], ["S", 20], ["E", 15], ["W", 15], ["C", 20]] as const),
    crt_dt: isoDate(created),
    actv_flg: rand() < 0.82 ? "Y" : "N",
    cr_lmt: (int(5, 200) * 500).toFixed(2),
  });
  const city = pick(CITIES);
  tables.cst_addr.push({ addr_id: tables.cst_addr.length + 1, cst_ref: id, addr_typ: "B", city, is_dflt: 1 });
  if (rand() < 0.6) {
    tables.cst_addr.push({ addr_id: tables.cst_addr.length + 1, cst_ref: id, addr_typ: "S", city: rand() < 0.7 ? city : pick(CITIES), is_dflt: rand() < 0.5 ? 1 : 0 });
  }
}

// A stale 2023 import that looks like the customer table but disagrees with it.
tables.tmp_import_2023 = tables.tbl_cst.slice(0, 250).map((row) => ({
  cst_id: row.cst_id,
  cst_nm: String(row.cst_nm).toUpperCase(),
  rgn_cd: rand() < 0.4 ? pick(["N", "S", "E", "W", "C"]) : row.rgn_cd,
  cst_typ: row.cst_typ,
  imp_batch: `B${int(1, 9)}`,
}));

// Products. Prices in cents.
const leafCats = [11, 12, 13, 21, 22, 31, 32];
const priceRange: Record<number, [number, number]> = { 11: [15000, 120000], 12: [40000, 250000], 13: [500, 6000], 21: [1500, 30000], 22: [8000, 90000], 31: [300, 2500], 32: [100, 1500] };
tables.tbl_prd = [];
for (let id = 1; id <= 150; id += 1) {
  const cat = id <= 140 ? pick(leafCats) : pick([1, 2, 3]);
  const [low, high] = priceRange[cat] ?? [1000, 20000];
  tables.tbl_prd.push({
    prd_id: id,
    prd_cd: `SKU-${String(id).padStart(5, "0")}`,
    prd_desc: `${tables.ref_cat.find((row) => row.cat_id === cat)!.cat_nm} item ${id}`,
    cat_id: cat,
    unt_prc: int(low, high),
    stat: weighted([[1, 75], [0, 15], [2, 10]] as const),
    wt_g: int(50, 15000),
  });
}

tables.sup = Array.from({ length: 15 }, (_, index) => ({
  sup_id: index + 1,
  sup_nm: `${pick(COMPANY_A)} Industries ${index + 1}`,
  ctry_iso2: pick(["EG", "CN", "DE", "TR", "IN", "AE"]),
}));

tables.whs = [
  { whs_id: 1, whs_nm: "Main DC", city: "Cairo" },
  { whs_id: 2, whs_nm: "Coastal", city: "Alexandria" },
  { whs_id: 3, whs_nm: "Upper", city: "Aswan" },
  { whs_id: 4, whs_nm: "Canal", city: "Suez" },
];

tables.inv_bal = [];
for (const product of tables.tbl_prd) {
  for (const warehouse of tables.whs) {
    if (rand() < 0.7) {
      tables.inv_bal.push({
        whs_ref: warehouse.whs_id,
        prd_ref: product.prd_id,
        qoh: int(0, 400),
        rop: int(10, 80),
        upd_ts: new Date(END - int(0, 60) * DAY).toISOString(),
      });
    }
  }
}

tables.prm = [
  { prm_id: 1, prm_cd: "WINTER24", pct_off: "10.00", vld_frm: "2024-01-01", vld_to: "2024-02-29" },
  { prm_id: 2, prm_cd: "SUMMER24", pct_off: "15.00", vld_frm: "2024-06-01", vld_to: "2024-08-31" },
  { prm_id: 3, prm_cd: "BF24", pct_off: "25.00", vld_frm: "2024-11-25", vld_to: "2024-11-30" },
  { prm_id: 4, prm_cd: "WINTER25", pct_off: "10.00", vld_frm: "2025-01-01", vld_to: "2025-02-28" },
  { prm_id: 5, prm_cd: "BF25", pct_off: "25.00", vld_frm: "2025-11-24", vld_to: "2025-11-29" },
];

// Orders and everything hanging off them.
tables.ord_hdr = [];
tables.ord_ln = [];
tables.shp = [];
tables.pmt = [];
tables.rtn = [];
tables.ord_prm = [];
for (let id = 1; id <= 3000; id += 1) {
  const placed = START + int(0, (END - START) / DAY) * DAY;
  const isTest = rand() < 0.012;
  const status = weighted([[10, 4], [20, 6], [30, 10], [40, 70], [90, 10]] as const);
  const channel = weighted([["W", 55], ["P", 15], ["R", 30]] as const);
  const customer = isTest ? 1 : int(2, 400);
  tables.ord_hdr.push({
    oh_id: id,
    cst_ref: customer,
    ord_dt: yyyymmdd(placed),
    sts: status,
    chnl: channel,
    rep_id: channel === "R" ? pick(salesReps) : null,
    disc_pct: rand() < 0.2 ? pick(["5.00", "10.00"]) : "0.00",
    is_tst: isTest ? 1 : 0,
  });

  let totalCents = 0;
  const lines = int(1, 5);
  for (let line = 0; line < lines; line += 1) {
    const product = pick(tables.tbl_prd);
    const qty = int(1, 12);
    const discount = rand() < 0.25 ? pick([0.05, 0.1, 0.15]) : 0;
    const lineId = tables.ord_ln.length + 1;
    tables.ord_ln.push({ ol_id: lineId, oh_ref: id, prd_ref: product.prd_id, qty, unt_prc_c: product.unt_prc, ln_disc: discount.toFixed(2) });
    totalCents += Math.round(qty * (product.unt_prc as number) * (1 - discount));
    if (status === 40 && rand() < 0.04) {
      tables.rtn.push({
        rtn_id: tables.rtn.length + 1,
        ol_ref: lineId,
        rsn_cd: weighted([["DMG", 40], ["WRG", 30], ["LATE", 15], ["OTH", 15]] as const),
        qty: int(1, qty),
        rtn_dt: isoDate(placed + int(5, 30) * DAY),
      });
    }
  }

  if (status >= 20 && status !== 90) {
    tables.pmt.push({ pmt_id: tables.pmt.length + 1, oh_ref: id, amt_c: totalCents, mthd: weighted([[1, 50], [2, 25], [3, 10], [4, 15]] as const), pmt_dt: isoDate(placed + int(0, 3) * DAY), rfnd_flg: "N" });
  } else if (status === 90 && rand() < 0.4) {
    tables.pmt.push({ pmt_id: tables.pmt.length + 1, oh_ref: id, amt_c: totalCents, mthd: 1, pmt_dt: isoDate(placed), rfnd_flg: "Y" });
  }
  if (status === 30 || status === 40) {
    const shipped = placed + int(1, 4) * DAY;
    tables.shp.push({
      shp_id: tables.shp.length + 1,
      oh_ref: id,
      whs_ref: int(1, 4),
      carr_cd: weighted([["DHL", 40], ["ARX", 35], ["LOC", 25]] as const),
      shp_dt: isoDate(shipped),
      dlv_dt: status === 40 ? isoDate(shipped + int(1, 9) * DAY) : null,
      trk_no: `TRK${String(id).padStart(7, "0")}`,
    });
  }
  const promo = tables.prm.find((row) => isoDate(placed) >= String(row.vld_frm) && isoDate(placed) <= String(row.vld_to));
  if (promo && rand() < 0.5) tables.ord_prm.push({ oh_ref: id, prm_ref: promo.prm_id });
}

tables.po_hdr = [];
tables.po_ln = [];
for (let id = 1; id <= 200; id += 1) {
  const status = weighted([["O", 15], ["R", 25], ["C", 60]] as const);
  tables.po_hdr.push({ po_id: id, sup_ref: int(1, 15), whs_ref: int(1, 4), po_dt: isoDate(START + int(0, 700) * DAY), po_sts: status });
  for (let line = 0; line < int(1, 4); line += 1) {
    const product = pick(tables.tbl_prd);
    const ordered = int(10, 200);
    tables.po_ln.push({
      po_ln_id: tables.po_ln.length + 1,
      po_ref: id,
      prd_ref: product.prd_id,
      qty_ord: ordered,
      qty_rcv: status === "O" ? 0 : status === "R" ? int(0, ordered) : ordered,
      cst_c: Math.round((product.unt_prc as number) * (0.5 + rand() * 0.2)),
    });
  }
}

tables.audit_log = Array.from({ length: 2000 }, (_, index) => ({
  id: index + 1,
  tbl: pick(["tbl_cst", "ord_hdr", "tbl_prd", "inv_bal"]),
  op: pick(["I", "U", "D"]),
  ts: new Date(START + int(0, 700) * DAY).toISOString(),
  payload: JSON.stringify({ by: pick(salesReps), note: pick(["sync", "manual", "batch"]) }),
}));

// ── schema ─────────────────────────────────────────────────────────────────
const DDL = `
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
CREATE TABLE ref_rgn (rgn_cd char(1) PRIMARY KEY, rgn_desc varchar(20) NOT NULL);
CREATE TABLE ref_cat (cat_id int PRIMARY KEY, cat_nm varchar(40) NOT NULL, prnt_cat_id int);
CREATE TABLE ref_sts (dom varchar(5) NOT NULL, cd smallint NOT NULL, dsc varchar(30) NOT NULL, PRIMARY KEY (dom, cd));
CREATE TABLE ref_dept (dept_cd varchar(4) PRIMARY KEY, dept_nm varchar(30) NOT NULL);
CREATE TABLE emp_mst (emp_no int PRIMARY KEY, f_nm varchar(30), l_nm varchar(30), dept_cd varchar(4), mgr_emp_no int, hire_dt date, term_dt date);
CREATE TABLE tbl_cst (cst_id int PRIMARY KEY, cst_nm varchar(80), cst_typ smallint, rgn_cd char(1), crt_dt date, actv_flg char(1), cr_lmt numeric(12,2));
COMMENT ON COLUMN tbl_cst.cst_typ IS '1=retail 2=wholesale 3=distributor';
CREATE TABLE cst_addr (addr_id int PRIMARY KEY, cst_ref int, addr_typ char(1), city varchar(40), is_dflt smallint);
CREATE TABLE tmp_import_2023 (cst_id int, cst_nm varchar(80), rgn_cd char(1), cst_typ smallint, imp_batch varchar(4));
CREATE TABLE tbl_prd (prd_id int PRIMARY KEY, prd_cd varchar(12), prd_desc varchar(80), cat_id int, unt_prc int, stat smallint, wt_g int);
CREATE TABLE sup (sup_id int PRIMARY KEY, sup_nm varchar(80), ctry_iso2 char(2));
CREATE TABLE whs (whs_id int PRIMARY KEY, whs_nm varchar(30), city varchar(40));
CREATE TABLE inv_bal (whs_ref int, prd_ref int, qoh int, rop int, upd_ts timestamp, PRIMARY KEY (whs_ref, prd_ref));
CREATE TABLE prm (prm_id int PRIMARY KEY, prm_cd varchar(12), pct_off numeric(5,2), vld_frm date, vld_to date);
CREATE TABLE ord_hdr (oh_id int PRIMARY KEY, cst_ref int, ord_dt int, sts smallint, chnl char(1), rep_id int, disc_pct numeric(4,2), is_tst smallint);
CREATE TABLE ord_ln (ol_id int PRIMARY KEY, oh_ref int, prd_ref int, qty int, unt_prc_c int, ln_disc numeric(4,2));
CREATE TABLE ord_prm (oh_ref int, prm_ref int);
CREATE TABLE shp (shp_id int PRIMARY KEY, oh_ref int, whs_ref int, carr_cd varchar(4), shp_dt date, dlv_dt date, trk_no varchar(12));
CREATE TABLE pmt (pmt_id int PRIMARY KEY, oh_ref int, amt_c bigint, mthd smallint, pmt_dt date, rfnd_flg char(1));
CREATE TABLE rtn (rtn_id int PRIMARY KEY, ol_ref int, rsn_cd varchar(4), qty int, rtn_dt date);
CREATE TABLE po_hdr (po_id int PRIMARY KEY, sup_ref int, whs_ref int, po_dt date, po_sts char(1));
CREATE TABLE po_ln (po_ln_id int PRIMARY KEY, po_ref int, prd_ref int, qty_ord int, qty_rcv int, cst_c int);
CREATE TABLE audit_log (id int PRIMARY KEY, tbl varchar(20), op char(1), ts timestamptz, payload jsonb);
`;

async function insertAll(client: pg.Client, table: string, rows: Row[]) {
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0]);
  for (let start = 0; start < rows.length; start += 500) {
    const chunk = rows.slice(start, start + 500);
    const values: unknown[] = [];
    const tuples = chunk.map((row) => `(${columns.map((column) => {
      values.push(row[column]);
      return `$${values.length}`;
    }).join(", ")})`);
    await client.query(`INSERT INTO ${table} (${columns.join(", ")}) VALUES ${tuples.join(", ")}`, values);
  }
}

async function connectAdmin(passwords: string[]) {
  let last: unknown;
  for (const password of passwords) {
    const client = new pg.Client({ host: HOST, port: PORT, database: DB, user: "erp_admin", password });
    try {
      await client.connect();
      return { client, password };
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

const env = readEnv();
const candidates = [env.MESSY_ADMIN_PASSWORD, process.env.BOOT_PASSWORD].filter((value): value is string => !!value);
if (candidates.length === 0) throw new Error("Set BOOT_PASSWORD on the first run.");
const { client, password } = await connectAdmin(candidates);

env.MESSY_ADMIN_PASSWORD ??= randomBytes(18).toString("hex");
env.MESSY_READER_PASSWORD ??= randomBytes(18).toString("hex");
if (password !== env.MESSY_ADMIN_PASSWORD) {
  await client.query(`ALTER USER erp_admin PASSWORD '${env.MESSY_ADMIN_PASSWORD}'`);
}
env.MESSY_READER_URL = `postgresql://kakaw_reader:${env.MESSY_READER_PASSWORD}@${HOST}:${PORT}/${DB}`;
writeFileSync(ENV_PATH, Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n") + "\n");

await client.query("BEGIN");
await client.query(DDL);
for (const [table, rows] of Object.entries(tables)) await insertAll(client, table, rows);
await client.query(`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kakaw_reader') THEN CREATE ROLE kakaw_reader LOGIN; END IF;
END $$`);
await client.query(`ALTER ROLE kakaw_reader WITH LOGIN PASSWORD '${env.MESSY_READER_PASSWORD}'`);
await client.query(`GRANT CONNECT ON DATABASE ${DB} TO kakaw_reader`);
await client.query("GRANT USAGE ON SCHEMA public TO kakaw_reader");
await client.query("GRANT SELECT ON ALL TABLES IN SCHEMA public TO kakaw_reader");
await client.query("COMMIT");
await client.query("ANALYZE");
await client.end();

console.log(
  Object.entries(tables)
    .map(([table, rows]) => `${table}: ${rows.length}`)
    .join("\n"),
);
console.log(`\nURLs written to ${ENV_PATH}`);
