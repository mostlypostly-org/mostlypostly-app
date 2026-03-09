// One-time script: create troy@rejuvesalonspa.com manager in prod
// Run: node scripts/create-rejuve-manager.js
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { db } from "../db.js";

const email    = "troy@rejuvesalonspa.com";
const password = "Password123";
const salon_id = "rejuve-salon-spa";
const name     = "Troy";

const hash = await bcrypt.hash(password, 10);
const existing = db.prepare("SELECT id FROM managers WHERE email=?").get(email);

if (existing) {
  db.prepare("UPDATE managers SET password_hash=? WHERE email=?").run(hash, email);
  console.log("Updated password for", email);
} else {
  const id = crypto.randomUUID().replace(/-/g, "");
  db.prepare("INSERT INTO managers (id,name,email,salon_id,password_hash) VALUES (?,?,?,?,?)").run(id, name, email, salon_id, hash);
  console.log("Created manager:", email, "->", salon_id);
}
