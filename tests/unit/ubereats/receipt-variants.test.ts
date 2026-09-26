/**
 * Every receipt permutation seen on a real account (2024-09 .. 2026-09), as scrubbed
 * fixtures. For each: the charges must add up to the receipt total - the invariant that
 * caught every parser bug so far.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { parse } from "node-html-parser";
import { inferMissingAmount, parseReceiptHtml, ReceiptPayment, textCells } from "../../../src/ubereats/receipt";

const read = (n: string) => readFileSync(join(__dirname, "../../fixtures", `receipt-${n}.html`), "utf8");
const receipt = (n: string) => parseReceiptHtml(read(n), n);
const cents = (n: number) => Math.round(n * 100);
const pays = (n: string) =>
  receipt(n).payments.map((p) => [p.brand, p.last4, p.amount, p.kind, p.info, p.chargedAt, p.amountInferred]);

const ALL = [
  "grocery",
  "options",
  "split-charges",
  "uber-cash",
  "restaurant",
  "legacy-grocery",
  "legacy-nickname",
  "legacy-refund",
  "legacy-updated",
  "split-uber-cash",
  "split-refund",
  "joined-suffix",
];

describe.each(ALL)("receipt %s", (name) => {
  test("charges add up to the receipt total, none inferred or missing", () => {
    const r = receipt(name);
    expect(r.payments.length).toBeGreaterThan(0);
    expect(r.payments.every((p) => (p.amount !== null && !p.amountInferred) || name === "options")).toBe(true);
    expect(cents(r.payments.reduce((s, p) => s + (p.amount ?? 0), 0))).toBe(cents(r.total!));
  });
  test("every charge has a method and a parseable time", () => {
    for (const p of receipt(name).payments) {
      expect(p.method).not.toBe("");
      expect(p.chargedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    }
  });
});

describe("layout detection", () => {
  test.each([
    ["grocery", "current"],
    ["split-uber-cash", "current"],
    ["legacy-grocery", "legacy"],
    ["legacy-refund", "legacy"],
  ])("%s is %s", (n, layout) => expect(receipt(n).layout).toBe(layout));
});

describe("current layout variants", () => {
  test("Uber's data_testid typo on split payments: amounts are read, not inferred", () => {
    expect(pays("split-uber-cash")).toEqual([
      ["Uber Cash", null, 15, "charge", null, "2026-03-01T23:47", false],
      ["American Express", "1111", 8.06, "charge", null, "2026-03-02T00:57", false],
    ]);
  });

  test("card charge, Uber Cash refund, then Uber Cash tip", () => {
    expect(pays("split-refund")).toEqual([
      ["American Express", "1111", 62, "charge", null, "2026-01-07T20:39", false],
      ["Uber Cash", null, -15.05, "refund", "Refund", "2026-01-07T20:39", false],
      ["Uber Cash", null, 10, "charge", null, "2026-01-07T21:31", false],
    ]);
    const lines = receipt("split-refund").fareLines.map((l) => l.key);
    expect(lines).toEqual(expect.arrayContaining(["meal_fare", "refund_adjustment", "previous_total", "new_total"]));
  });

  test('a card shared from another account: "Visa ••••NNNN (Joined Card)"', () => {
    const [p] = receipt("joined-suffix").payments;
    expect(p).toMatchObject({ brand: "Visa", last4: "3333", amount: 56.36 });
  });
});

describe("legacy layout variants (no data-testid hooks)", () => {
  test("grocery: store, date, every item with amount, fares, and a Joined Card charge", () => {
    const r = receipt("legacy-grocery");
    expect(r).toMatchObject({
      storeName: "Jewel-Osco (1340 S Canal St)",
      headerDate: "September 6, 2025",
      total: 45.42,
    });
    expect(r.items.map((i) => [i.title, i.quantity, i.amount])).toEqual([
      ["Simply All Natural Grapefruit Juice (52 fl oz)", 1, 5.61],
      ["Voodoo Ranger Imperial Ipa Beer (19.2 fl oz)", 1, 4.35],
      ["Voodoo Ranger Juice Force Hazy Imperial Ipa Beer (19.2 fl oz)", 1, 4.35],
      ["Califia Farms Unsweetened Almond Milk (48 fl oz)", 1, 5.61],
      ["Califia Farms Pumpkin Spice Almondmilk Creamer (25.4 fl oz)", 1, 6.73],
      ["Kemps Select 2% Reduced Fat Milk (1 gal)", 1, 5.61],
    ]);
    expect(r.fareLines.map((l) => [l.key, l.amount])).toEqual([
      ["item_subtotal", 32.26],
      ["delivery_fee", 2.99],
      ["service_fee", 5.48],
      ["tax", 1.31],
      ["tip", 5],
      ["special_offers", -1.62],
    ]);
    expect(pays("legacy-grocery")).toEqual([["Joined Card", "3333", 45.42, "charge", null, "2025-09-06T21:39", false]]);
  });

  test("a nicknamed card and a savings banner before the items", () => {
    const r = receipt("legacy-nickname");
    expect(r.payments[0]).toMatchObject({ brand: "House", last4: "4444", amount: 28.4 });
    expect(r.items).toHaveLength(1);
    expect(r.notifications.join(" ")).toMatch(/saved/i);
  });

  test('"Refund" printed AFTER the amount, and the separately billed tip', () => {
    expect(pays("legacy-refund")).toEqual([
      ["Uber Cash", null, 15, "charge", null, "2025-04-01T12:05", false],
      ["American Express", "1111", 3.83, "charge", null, "2025-04-01T12:06", false],
      ["Uber Cash", null, -18.83, "refund", "Refund", "2025-04-01T12:15", false],
      ["American Express", "1111", 3.95, "charge", null, "2025-04-01T13:05", false],
    ]);
  });

  test('an UPDATED receipt: fare section opens with "Meal Fare"; the $0.78 card remainder', () => {
    const r = receipt("legacy-updated");
    expect(r.fareLines[0]).toEqual({ key: "meal_fare", label: "Meal Fare", amount: 22.77 });
    expect(r.fareLines.find((l) => l.key === "new_total")?.amount).toBe(5.94);
    expect(r.notifications).toContain("The tip has been processed");
    expect(r.payments.map((p) => [p.brand, p.amount])).toEqual([
      ["House", 27.52],
      ["Uber Cash", -27.52],
      ["Uber Cash", 5.16],
      ["House", 0.78],
    ]);
  });

  test("text cells come out in document order, skipping style/script", () => {
    const cells = textCells(
      parse("<table><tr><td>a</td><td><div>b</div></td></tr></table><style>x{}</style><p> c </p>"),
    );
    expect(cells).toEqual(["a", "b", "c"]);
  });

  test("non-dollar currencies are money cells too; a bare number stays a quantity", () => {
    const cell = (t: string) => `<tr><td>${t}</td></tr>`;
    const html =
      "<table>" +
      [
        "€14.50",
        "Total",
        "€14.50",
        "2",
        "Espresso",
        "€6.00",
        "€3.00/pc",
        "Subtotal",
        "€6.00",
        "Service Fee",
        "€8.50",
        "Payments",
        "Visa ••••1234",
        "3/4/25 9:05 AM",
        "€14.50",
      ]
        .map(cell)
        .join("") +
      "</table>";
    const r = parseReceiptHtml(html, "eur");
    expect(r.items).toEqual([{ id: "legacy-0", title: "Espresso", quantity: 2, amount: 6, options: [] }]);
    expect(r.fareLines.map((l) => [l.key, l.amount])).toEqual([
      ["item_subtotal", 6],
      ["service_fee", 8.5],
    ]);
    expect(r.payments[0]).toMatchObject({ last4: "1234", amount: 14.5, amountInferred: false });
  });

  test("a legacy page with no Payments section yields no charges, not garbage", () => {
    const r = parseReceiptHtml("<table><tr><td>Total</td><td>$5.00</td></tr></table>", "x");
    expect(r).toMatchObject({ layout: "legacy", total: 5, payments: [], items: [] });
  });
});

describe("inferMissingAmount", () => {
  const p = (amount: number | null, i = 0): ReceiptPayment => ({
    index: i,
    method: "m",
    brand: null,
    last4: null,
    amount,
    amountInferred: false,
    chargedAtText: null,
    chargedAt: null,
    info: null,
    kind: "charge",
  });
  test("one missing among several = total minus the rest, flagged", () => {
    const ps = [p(15), p(null, 1)];
    inferMissingAmount(ps, 23.06);
    expect(ps[1]).toMatchObject({ amount: 8.06, amountInferred: true });
  });
  test("a negative remainder is a refund", () => {
    const ps = [p(20), p(null, 1)];
    inferMissingAmount(ps, 5);
    expect(ps[1]).toMatchObject({ amount: -15, kind: "refund" });
  });
  test("two missing, or no total: nothing is guessed", () => {
    const two = [p(null), p(null, 1)];
    inferMissingAmount(two, 10);
    expect(two.every((x) => x.amount === null)).toBe(true);
    const noTotal = [p(null)];
    inferMissingAmount(noTotal, null);
    expect(noTotal[0].amount).toBeNull();
  });
});
