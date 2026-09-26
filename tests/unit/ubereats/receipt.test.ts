import { readFileSync } from "fs";
import { join } from "path";
import { parseCard, parseChargeTime, parseMoney, parseReceiptHtml } from "../../../src/ubereats/receipt";

const receipt = (name: string) =>
  parseReceiptHtml(readFileSync(join(__dirname, "../../fixtures", `receipt-${name}.html`), "utf8"), name);

describe("parseReceiptHtml (real, scrubbed receipts)", () => {
  test("grocery: one card charge, fare lines, pickup/drop-off", () => {
    const r = receipt("grocery");
    expect(r).toMatchObject({ storeName: "Target (Kips Bay)", total: 36.55, headerDate: "Sep 21, 2026" });
    expect(r.payments).toEqual([
      {
        index: 0,
        method: "American Express ••••1111",
        brand: "American Express",
        last4: "1111",
        amount: 36.55,
        amountInferred: false,
        chargedAtText: "9/22/26 6:10 AM",
        chargedAt: "2026-09-22T06:10",
        info: null,
        kind: "charge",
      },
    ]);
    expect(r.fareLines.map((l) => [l.key, l.amount])).toEqual([
      ["item_subtotal", 25.18],
      ["tax", 2.98],
      ["delivery_fee", 0.99],
      ["service_fee", 7.4],
    ]);
    expect(r.pickup?.address).toBe("519 2nd Ave, New York City, NY 10016, USA");
    // grocery receipts print no per-line amount
    expect(r.items.map((i) => [i.id, i.quantity, i.amount])).toEqual([
      ["166dbc2b-b767-44ab-82f3-842eb73bcf99", 1, null],
      ["84b735c8-97ce-40da-852f-ac521e3eca84", 1, null],
    ]);
  });

  test("a tip billed later on another card, and a refund, are separate rows", () => {
    const r = receipt("split-charges");
    expect(r.payments.map((p) => [p.last4, p.amount, p.chargedAt, p.kind, p.info])).toEqual([
      ["2222", 22.3, "2026-06-24T09:48", "charge", null],
      ["1111", 2.56, "2026-06-24T11:50", "charge", null],
      ["2222", -6.13, "2026-06-24T17:49", "refund", "Refund"],
    ]);
    expect(r.total).toBe(18.73);
    expect(r.notifications).toEqual(["The tip has been processed"]);
    expect(r.items).toEqual([]); // tip receipts omit the cart
    expect(r.fareLines.filter((l) => l.key === "tip")).toHaveLength(1); // repeated test ids are read once
  });

  test("restaurant lines carry exact amounts and the printed options", () => {
    const r = receipt("options");
    expect(r.items.map((i) => [i.quantity, i.amount])).toEqual([
      [2, 16.18],
      [1, 7.49],
    ]);
    expect(r.items[0].options).toContain("Milk ($0.10)");
  });

  test("an amount marked with Uber's data_testid typo is read as printed, not inferred", () => {
    const [p] = receipt("options").payments;
    expect(p).toMatchObject({ amount: 26.75, amountInferred: false, last4: "1111" });
  });

  test("Uber Cash has no card digits", () => {
    const [p] = receipt("uber-cash").payments;
    expect(p).toMatchObject({ method: "Uber Cash", brand: "Uber Cash", last4: null, amount: 10.32 });
  });

  test("empty / foreign HTML yields an empty receipt, not a throw", () => {
    const r = parseReceiptHtml("<html><body>nothing</body></html>", "x");
    expect(r).toMatchObject({ total: null, payments: [], items: [], fareLines: [], pickup: null });
  });
});

describe("field parsers", () => {
  test.each([
    ["$36.55", 36.55],
    ["-$6.13", -6.13],
    ["−$0.99", -0.99],
    ["$1,234.50", 1234.5],
    ["", null],
    ["Free", null],
  ])("parseMoney(%j) = %j", (text, n) => expect(parseMoney(text)).toBe(n));

  test.each([
    ["9/22/26 6:10 AM", "2026-09-22T06:10"],
    ["6/24/26 12:05 PM", "2026-06-24T12:05"],
    ["1/2/2025 12:30 AM", "2025-01-02T00:30"],
    ["yesterday", null],
  ])("parseChargeTime(%j) = %j", (text, iso) => expect(parseChargeTime(text)).toBe(iso));

  test.each([
    ["American Express ••••1234", "American Express", "1234"],
    ["Visa ****5678", "Visa", "5678"],
    ["Mastercard ending in 0000", "Mastercard", "0000"],
    ["Uber Cash", "Uber Cash", null],
  ])("parseCard(%j)", (text, brand, last4) => expect(parseCard(text)).toEqual({ brand, last4 }));
});
