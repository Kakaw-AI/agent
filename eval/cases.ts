/**
 * Questions with known-correct SQL against eval/seed.ts.
 *
 * Wording is precise on purpose: "total order amount" rather than "revenue",
 * so a case fails because the agent got it wrong, not because the question
 * allowed two readings. The ambiguous cases are the exception and expect a
 * clarifying question.
 */

export type EvalTurn = { question: string; sql: string };

export type EvalCase = {
  id: string;
  category:
    | "basic"
    | "value_trap"
    | "small_talk_trap"
    | "greeting"
    | "follow_up"
    | "chart_follow_up"
    | "ambiguous"
    // messy fixture (eval/messy/cases.ts)
    | "coded_value"
    | "lookup"
    | "int_date"
    | "units"
    | "hidden_join"
    | "hierarchy";
  question: string;
  /** Correct SQL for `question`. Absent for greetings and ambiguous cases. */
  sql?: string;
  /** Earlier turns, replayed as conversation history with their results. */
  history?: EvalTurn[];
  /** Simulates a backend query-memory hit on the raw question text. */
  exactPlanSql?: string;
  /** Cases in one group run in order; groups run concurrently. */
  group?: string;
};

const REGION_TOTALS = (year: string) =>
  `SELECT c.region, SUM(o.total_amount) AS total FROM orders o JOIN customers c ON c.id = o.customer_id WHERE strftime('%Y', o.order_date) = '${year}' GROUP BY c.region`;

export const CASES: EvalCase[] = [
  // ── basics ──────────────────────────────────────────────────────────────
  { id: "b1", category: "basic", question: "How many customers do we have?", sql: "SELECT COUNT(*) FROM customers" },
  { id: "b2", category: "basic", question: "What is the total amount of all orders placed in 2024?", sql: "SELECT SUM(total_amount) FROM orders WHERE strftime('%Y', order_date) = '2024'" },
  { id: "b3", category: "basic", question: "Which 5 customers have the highest total order amount? Show their name and total.", sql: "SELECT c.name, SUM(o.total_amount) AS total FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.id ORDER BY total DESC LIMIT 5" },
  { id: "b4", category: "basic", question: "How many orders were placed in each month of 2024?", sql: "SELECT strftime('%Y-%m', order_date) AS month, COUNT(*) FROM orders WHERE strftime('%Y', order_date) = '2024' GROUP BY month" },
  { id: "b5", category: "basic", question: "How many products are there in each product category?", sql: "SELECT category, COUNT(*) FROM products GROUP BY category" },
  { id: "b6", category: "basic", question: "What is the average order amount for each customer region?", sql: "SELECT c.region, AVG(o.total_amount) FROM orders o JOIN customers c ON c.id = o.customer_id GROUP BY c.region" },
  { id: "b7", category: "basic", question: "Which product has sold the most units in total? Give its name and the number of units.", sql: "SELECT p.name, SUM(oi.quantity) AS units FROM order_items oi JOIN products p ON p.id = oi.product_id GROUP BY p.id ORDER BY units DESC LIMIT 1" },
  { id: "b8", category: "basic", question: "How many orders have been returned?", sql: "SELECT COUNT(DISTINCT order_id) FROM returns" },

  // ── value traps: the stored value differs from how people say it ────────
  { id: "v1", category: "value_trap", question: "How many orders were cancelled?", sql: "SELECT COUNT(*) FROM orders WHERE status = 'Cancelled'" },
  { id: "v2", category: "value_trap", question: "What is the total order amount from small business customers?", sql: "SELECT SUM(o.total_amount) FROM orders o JOIN customers c ON c.id = o.customer_id WHERE c.segment = 'Small Business'" },
  { id: "v3", category: "value_trap", question: "How many orders used express shipping?", sql: "SELECT COUNT(*) FROM orders WHERE ship_mode = 'Express'" },
  { id: "v4", category: "value_trap", question: "How many customers are based in APAC?", sql: "SELECT COUNT(*) FROM customers WHERE region = 'Asia Pacific'" },
  { id: "v5", category: "value_trap", question: "How many products are in the office supplies category?", sql: "SELECT COUNT(*) FROM products WHERE category = 'Office Supplies'" },
  { id: "v6", category: "value_trap", question: "How many returns happened because the item arrived damaged?", sql: "SELECT COUNT(*) FROM returns WHERE reason = 'Damaged'" },
  { id: "v7", category: "value_trap", question: "How many orders are still being processed?", sql: "SELECT COUNT(*) FROM orders WHERE status = 'Processing'" },

  // ── data questions that start like small talk ───────────────────────────
  { id: "s1", category: "small_talk_trap", question: "hi, how many customers signed up in 2024?", sql: "SELECT COUNT(*) FROM customers WHERE strftime('%Y', signup_date) = '2024'" },
  { id: "s2", category: "small_talk_trap", question: "help me find the 3 most expensive products", sql: "SELECT name, unit_price FROM products ORDER BY unit_price DESC LIMIT 3" },
  { id: "g1", category: "greeting", question: "hello!" },

  // ── follow-ups that only make sense with the conversation ───────────────
  {
    id: "f1", category: "follow_up", group: "cache-trap",
    history: [{ question: "What was the total order amount in each customer region in 2024?", sql: REGION_TOTALS("2024") }],
    question: "what about 2025?", sql: REGION_TOTALS("2025"),
  },
  {
    // Same follow-up text as f1 in a different conversation. A cache keyed on
    // the raw question hands back f1's SQL here.
    id: "f2", category: "follow_up", group: "cache-trap",
    history: [{ question: "How many customers signed up in 2024?", sql: "SELECT COUNT(*) FROM customers WHERE strftime('%Y', signup_date) = '2024'" }],
    question: "what about 2025?", sql: "SELECT COUNT(*) FROM customers WHERE strftime('%Y', signup_date) = '2025'",
  },
  {
    id: "f3", category: "follow_up",
    history: [{ question: "How many orders were delivered?", sql: "SELECT COUNT(*) FROM orders WHERE status = 'Delivered'" }],
    question: "and how many were cancelled?", sql: "SELECT COUNT(*) FROM orders WHERE status = 'Cancelled'",
  },
  {
    id: "f4", category: "follow_up",
    history: [{ question: "What are the top 5 products by total units sold?", sql: "SELECT p.name, SUM(oi.quantity) AS units FROM order_items oi JOIN products p ON p.id = oi.product_id GROUP BY p.id ORDER BY units DESC LIMIT 5" }],
    question: "only electronics", sql: "SELECT p.name, SUM(oi.quantity) AS units FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE p.category = 'Electronics' GROUP BY p.id ORDER BY units DESC LIMIT 5",
  },
  {
    id: "f5", category: "follow_up",
    history: [{ question: "How many orders were placed in each month of 2024?", sql: "SELECT strftime('%Y-%m', order_date) AS month, COUNT(*) AS orders FROM orders WHERE strftime('%Y', order_date) = '2024' GROUP BY month" }],
    question: "now only the ones with express shipping", sql: "SELECT strftime('%Y-%m', order_date) AS month, COUNT(*) FROM orders WHERE strftime('%Y', order_date) = '2024' AND ship_mode = 'Express' GROUP BY month",
  },
  {
    id: "f6", category: "follow_up",
    history: [{ question: "What is the total order amount per customer segment?", sql: "SELECT c.segment, SUM(o.total_amount) AS total FROM orders o JOIN customers c ON c.id = o.customer_id GROUP BY c.segment" }],
    question: "break that down by region as well", sql: "SELECT c.segment, c.region, SUM(o.total_amount) FROM orders o JOIN customers c ON c.id = o.customer_id GROUP BY c.segment, c.region",
  },
  {
    // The backend matches query memory on the raw text, so "what about Latin
    // America?" can arrive with SQL saved from an unrelated conversation.
    id: "f7", category: "follow_up",
    history: [{ question: "What is the average order amount for customers in Europe?", sql: "SELECT AVG(o.total_amount) FROM orders o JOIN customers c ON c.id = o.customer_id WHERE c.region = 'Europe'" }],
    question: "what about Latin America?",
    exactPlanSql: "SELECT COUNT(*) AS customers FROM customers WHERE region = 'Latin America'",
    sql: "SELECT AVG(o.total_amount) FROM orders o JOIN customers c ON c.id = o.customer_id WHERE c.region = 'Latin America'",
  },

  // ── "chart it" follow-ups ───────────────────────────────────────────────
  {
    id: "c1", category: "chart_follow_up",
    history: [{ question: "What is the total order amount per product category?", sql: "SELECT p.category, SUM(oi.quantity * p.unit_price) AS total FROM order_items oi JOIN products p ON p.id = oi.product_id GROUP BY p.category" }],
    question: "show it as a pie chart", sql: "SELECT p.category, SUM(oi.quantity * p.unit_price) AS total FROM order_items oi JOIN products p ON p.id = oi.product_id GROUP BY p.category",
  },
  {
    id: "c2", category: "chart_follow_up",
    history: [{ question: "How many orders were placed in each month of 2024?", sql: "SELECT strftime('%Y-%m', order_date) AS month, COUNT(*) AS orders FROM orders WHERE strftime('%Y', order_date) = '2024' GROUP BY month" }],
    question: "plot that", sql: "SELECT strftime('%Y-%m', order_date) AS month, COUNT(*) AS orders FROM orders WHERE strftime('%Y', order_date) = '2024' GROUP BY month",
  },

  // ── genuinely ambiguous: a clarifying question is the right answer ──────
  { id: "a1", category: "ambiguous", question: "Who are our best customers?" },
  { id: "a2", category: "ambiguous", question: "Which products perform best?" },
];
