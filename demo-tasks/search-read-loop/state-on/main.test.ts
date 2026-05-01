import { findIndex } from "./main.ts";

const arr = [10, 20, 30, 40];
const got = findIndex(arr, 30);
if (got !== 2) {
  console.error(`expected 2, got ${got}`);
  process.exit(1);
}
console.log("OK");
