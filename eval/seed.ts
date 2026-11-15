import Database from "better-sqlite3";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

/**
 * A small shop database with deterministic contents, so a question has the
 * same correct answer on every run.
 *
 * The categorical values are chosen to be easy to guess wrong: capitalised
 * statuses ('Cancelled'), multi-word segments ('Small Business'), and a region
 * nobody names the way it is stored ('Asia Pacific', asked about as "APAC").
 * SQLite's `=` is case-sensitive, so a guessed value returns no rows rather
 * than an error.
 */

// mulberry32: tiny seeded PRNG, enough for reproducible fixtures.
function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PRODUCTS: Array<[string, string, number]> = [
  ["Wireless Mouse", "Electronics", 24.99],
  ["Mechanical Keyboard", "Electronics", 89],
  ["27-inch Monitor", "Electronics", 249],
  ["USB-C Hub", "Electronics", 39.5],
  ["Noise-Cancelling Headphones", "Electronics", 199],
  ["HD Webcam", "Electronics", 69],
  ["Portable SSD 1TB", "Electronics", 119],
  ["Laser Printer", "Electronics", 299],
  ["Smart Speaker", "Electronics", 79],
  ["10-inch Tablet", "Electronics", 329],
  ["A4 Paper Ream", "Office Supplies", 6.5],
  ["Gel Pens 12-pack", "Office Supplies", 9.99],
  ["Stapler", "Office Supplies", 12],
  ["Sticky Notes", "Office Supplies", 4.75],
  ["Desk Organizer", "Office Supplies", 18.5],
  ["Whiteboard Markers", "Office Supplies", 8.25],
  ["Binder Clips", "Office Supplies", 3.99],
  ["Notebook Pack", "Office Supplies", 14],
  ["Label Maker", "Office Supplies", 45],
  ["Paper Shredder", "Office Supplies", 129],
  ["Ergonomic Chair", "Furniture", 349],
  ["Standing Desk", "Furniture", 499],
  ["Bookshelf", "Furniture", 159],
  ["Filing Cabinet", "Furniture", 189],
  ["Desk Lamp", "Furniture", 39],
  ["Conference Table", "Furniture", 899],
  ["Office Sofa", "Furniture", 649],
  ["Monitor Arm", "Furniture", 99],
  ["Footrest", "Furniture", 29],
  ["Coat Stand", "Furniture", 49],
];

const FIRST = ["Ava", "Liam", "Mia", "Noah", "Zoe", "Omar", "Lena", "Ravi", "Sara", "Ken", "Ines", "Tom", "Yara", "Leo", "Nina", "Ali"];
const LAST = ["Thompson", "Garcia", "Kim", "Okafor", "Novak", "Haddad", "Silva"];

function pick<T>(random: () => number, weighted: Array<[T, number]>): T {
  const roll = random();
  let total = 0;
  for (const [value, weight] of weighted) {
    total += weight;
    if (roll < total) return value;
  }
  return weighted[weighted.length - 1][0];
}

function isoDate(start: Date, end: Date, random: () => number): string {
  const time = start.getTime() + Math.floor(random() * (end.getTime() - start.getTime()));
  return new Date(time).toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function seedShopDatabase(path: string): void {
  if (existsSync(path)) rmSync(path);
  mkdirSync(dirname(path), { recursive: true });

  const random = rng(42);
  const db = new Database(path);
  db.exec(`
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      region TEXT NOT NULL,
      segment TEXT NOT NULL,
      signup_date TEXT NOT NULL
    );
    CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      unit_price REAL NOT NULL
    );
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      order_date TEXT NOT NULL,
      status TEXT NOT NULL,
      ship_mode TEXT NOT NULL,
      total_amount REAL NOT NULL
    );
    CREATE TABLE order_items (
      id INTEGER PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL
    );
    CREATE TABLE returns (
      id INTEGER PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      return_date TEXT NOT NULL,
      reason TEXT NOT NULL
    );
  `);

  const insertProduct = db.prepare("INSERT INTO products (id, name, category, unit_price) VALUES (?, ?, ?, ?)");
  const insertCustomer = db.prepare("INSERT INTO customers (id, name, email, region, segment, signup_date) VALUES (?, ?, ?, ?, ?, ?)");
  const insertOrder = db.prepare("INSERT INTO orders (id, customer_id, order_date, status, ship_mode, total_amount) VALUES (?, ?, ?, ?, ?, ?)");
  const insertItem = db.prepare("INSERT INTO order_items (order_id, product_id, quantity) VALUES (?, ?, ?)");
  const insertReturn = db.prepare("INSERT INTO returns (order_id, return_date, reason) VALUES (?, ?, ?)");

  db.transaction(() => {
    PRODUCTS.forEach(([name, category, price], index) => insertProduct.run(index + 1, name, category, price));

    const signups: string[] = [];
    for (let id = 1; id <= 80; id += 1) {
      const first = FIRST[(id * 7) % FIRST.length];
      const last = LAST[(id * 5 + Math.floor(id / FIRST.length)) % LAST.length];
      const name = `${first} ${last} ${id}`;
      const region = pick(random, [["North America", 0.35], ["Europe", 0.3], ["Asia Pacific", 0.2], ["Latin America", 0.15]]);
      const segment = pick(random, [["Consumer", 0.5], ["Corporate", 0.3], ["Small Business", 0.2]]);
      const signup = isoDate(new Date("2023-06-01"), new Date("2025-05-31"), random);
      signups.push(signup);
      insertCustomer.run(id, name, `${first}.${last}${id}`.toLowerCase() + "@example.com", region, segment, signup);
    }

    for (let id = 1; id <= 600; id += 1) {
      const customerId = 1 + Math.floor(random() * 80);
      let orderDate = isoDate(new Date("2024-01-01"), new Date("2025-06-30"), random);
      if (orderDate < signups[customerId - 1]) orderDate = signups[customerId - 1];
      const status = orderDate >= "2025-06-15"
        ? pick(random, [["Processing", 0.6], ["Shipped", 0.4]])
        : pick(random, [["Delivered", 0.72], ["Shipped", 0.1], ["Processing", 0.06], ["Cancelled", 0.12]]);
      const shipMode = pick(random, [["Standard", 0.6], ["Express", 0.3], ["Same Day", 0.1]]);

      const itemCount = 1 + Math.floor(random() * 4);
      const productIds = new Set<number>();
      while (productIds.size < itemCount) productIds.add(1 + Math.floor(random() * PRODUCTS.length));

      let total = 0;
      const items: Array<[number, number]> = [];
      for (const productId of productIds) {
        const quantity = 1 + Math.floor(random() * 5);
        total += quantity * PRODUCTS[productId - 1][2];
        items.push([productId, quantity]);
      }

      insertOrder.run(id, customerId, orderDate, status, shipMode, Math.round(total * 100) / 100);
      for (const [productId, quantity] of items) insertItem.run(id, productId, quantity);

      if (status === "Delivered" && random() < 0.1) {
        const reason = pick(random, [["Damaged", 0.35], ["Wrong Item", 0.25], ["Late Delivery", 0.2], ["Changed Mind", 0.2]]);
        insertReturn.run(id, addDays(orderDate, 5 + Math.floor(random() * 25)), reason);
      }
    }
  })();

  db.close();
}
