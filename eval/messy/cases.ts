/**
 * Questions against the messy ERP (eval/messy/seed.ts), with correct
 * PostgreSQL. Each one needs a fact the schema does not state outright: what a
 * code means, which table to join without a foreign key, that money is in
 * cents, that ord_dt is a yyyymmdd integer, or which of two look-alike tables
 * is current. Worded the way a user would ask, never in column names.
 */
import type { EvalCase } from "../cases.js";

export const MESSY_CASES: EvalCase[] = [
  // ── codes and flags ─────────────────────────────────────────────────────
  { id: "m01", category: "basic", question: "How many customers do we have?", sql: "SELECT COUNT(*) FROM tbl_cst" },
  { id: "m02", category: "coded_value", question: "How many customers are active?", sql: "SELECT COUNT(*) FROM tbl_cst WHERE actv_flg = 'Y'" },
  { id: "m03", category: "coded_value", question: "How many wholesale customers are there?", sql: "SELECT COUNT(*) FROM tbl_cst WHERE cst_typ = 2" },
  { id: "m04", category: "lookup", question: "How many customers are in the North region?", sql: "SELECT COUNT(*) FROM tbl_cst WHERE rgn_cd = 'N'" },
  { id: "m05", category: "lookup", question: "Which region has the most customers? Give the region's name.", sql: "SELECT r.rgn_desc FROM tbl_cst c JOIN ref_rgn r ON r.rgn_cd = c.rgn_cd GROUP BY r.rgn_desc ORDER BY COUNT(*) DESC LIMIT 1" },
  { id: "m06", category: "lookup", question: "How many orders were cancelled?", sql: "SELECT COUNT(*) FROM ord_hdr WHERE sts = 90" },
  { id: "m07", category: "coded_value", question: "How many orders are test orders?", sql: "SELECT COUNT(*) FROM ord_hdr WHERE is_tst = 1" },
  { id: "m08", category: "coded_value", question: "How many orders were placed through a sales rep?", sql: "SELECT COUNT(*) FROM ord_hdr WHERE chnl = 'R'" },
  { id: "m09", category: "coded_value", question: "How many payments were refunded?", sql: "SELECT COUNT(*) FROM pmt WHERE rfnd_flg = 'Y'" },
  { id: "m10", category: "coded_value", question: "How many purchase orders are still open?", sql: "SELECT COUNT(*) FROM po_hdr WHERE po_sts = 'O'" },

  // ── dates stored as numbers ─────────────────────────────────────────────
  { id: "m11", category: "int_date", question: "How many orders were placed in March 2025?", sql: "SELECT COUNT(*) FROM ord_hdr WHERE ord_dt BETWEEN 20250301 AND 20250331" },
  { id: "m12", category: "int_date", question: "How many orders were placed in each year? Show the year and the count.", sql: "SELECT ord_dt / 10000 AS yr, COUNT(*) FROM ord_hdr GROUP BY 1" },

  // ── money in cents ──────────────────────────────────────────────────────
  { id: "m13", category: "units", question: "What is the average product price?", sql: "SELECT AVG(unt_prc) / 100.0 FROM tbl_prd" },
  { id: "m14", category: "units", question: "What is the total amount customers have paid, not counting refunded payments?", sql: "SELECT SUM(amt_c) / 100.0 FROM pmt WHERE rfnd_flg = 'N'" },
  { id: "m15", category: "units", question: "What is the total value of the order lines of delivered orders, after line discounts?", sql: "SELECT SUM(l.qty * l.unt_prc_c * (1 - l.ln_disc)) / 100.0 FROM ord_ln l JOIN ord_hdr h ON h.oh_id = l.oh_ref WHERE h.sts = 40" },

  // ── joins with no foreign key ───────────────────────────────────────────
  { id: "m16", category: "hidden_join", question: "Leaving out test orders, which 3 customers placed the most orders? Give the customer id and the number of orders.", sql: "SELECT cst_ref, COUNT(*) FROM ord_hdr WHERE is_tst = 0 GROUP BY cst_ref ORDER BY COUNT(*) DESC LIMIT 3" },
  { id: "m17", category: "hidden_join", question: "Which product subcategory has the most order lines? Give its name.", sql: "SELECT c.cat_nm FROM ord_ln l JOIN tbl_prd p ON p.prd_id = l.prd_ref JOIN ref_cat c ON c.cat_id = p.cat_id GROUP BY c.cat_nm ORDER BY COUNT(*) DESC LIMIT 1" },
  { id: "m18", category: "hidden_join", question: "How many orders used the BF24 promotion?", sql: "SELECT COUNT(*) FROM ord_prm o JOIN prm p ON p.prm_id = o.prm_ref WHERE p.prm_cd = 'BF24'" },
  { id: "m19", category: "hidden_join", question: "Which sales rep took the most orders? Give their employee number.", sql: "SELECT rep_id FROM ord_hdr WHERE rep_id IS NOT NULL GROUP BY rep_id ORDER BY COUNT(*) DESC LIMIT 1" },
  { id: "m20", category: "hidden_join", question: "How many customers in the South region placed at least one order in 2025?", sql: "SELECT COUNT(DISTINCT c.cst_id) FROM tbl_cst c JOIN ord_hdr h ON h.cst_ref = c.cst_id WHERE c.rgn_cd = 'S' AND h.ord_dt BETWEEN 20250101 AND 20251231" },
  { id: "m21", category: "hidden_join", question: "What is the most common reason for returns? Give the reason code.", sql: "SELECT rsn_cd FROM rtn GROUP BY rsn_cd ORDER BY COUNT(*) DESC LIMIT 1" },

  // ── hierarchies and self references ─────────────────────────────────────
  { id: "m22", category: "hierarchy", question: "How many products are in the Electronics category, counting its subcategories?", sql: "SELECT COUNT(*) FROM tbl_prd WHERE cat_id IN (SELECT cat_id FROM ref_cat WHERE cat_id = 1 OR prnt_cat_id = 1)" },
  { id: "m23", category: "hierarchy", question: "Which employee has the most direct reports? Give their employee number.", sql: "SELECT mgr_emp_no FROM emp_mst WHERE mgr_emp_no IS NOT NULL GROUP BY mgr_emp_no ORDER BY COUNT(*) DESC LIMIT 1" },
  { id: "m24", category: "basic", question: "How many employees still work here?", sql: "SELECT COUNT(*) FROM emp_mst WHERE term_dt IS NULL" },

  // ── stock and shipping ──────────────────────────────────────────────────
  { id: "m25", category: "basic", question: "How many product stock records in our warehouses are below their reorder point?", sql: "SELECT COUNT(*) FROM inv_bal WHERE qoh < rop" },
  { id: "m26", category: "basic", question: "On average, how many days does a shipment take from shipping to delivery?", sql: "SELECT AVG(dlv_dt - shp_dt) FROM shp WHERE dlv_dt IS NOT NULL" },
];
