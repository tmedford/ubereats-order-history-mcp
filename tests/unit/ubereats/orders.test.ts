import { readFileSync } from "fs";
import { join } from "path";
import {
  fareBucket,
  parseFare,
  parseItem,
  parseOrder,
  parseOrdersPage,
  withReceiptLineTotals,
} from "../../../src/ubereats/orders";

const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, "../../fixtures", name), "utf8"));

describe("parseOrdersPage (real, scrubbed getPastOrdersV1 page)", () => {
  const page = parseOrdersPage(fixture("past-orders-page.json"));

  test("keeps the API's newest-first order and reports hasMore", () => {
    expect(page.ids).toHaveLength(4);
    expect(page.orders.map((o) => o.store.name)).toEqual([
      "Target",
      "Zucker's Bagels",
      "McDonald's®",
      "The Home Depot",
    ]);
    expect(page.hasMore).toBe(true);
  });

  test("a grocery order: items, unit prices, full fare breakdown", () => {
    const o = page.orders[0];
    expect(o).toMatchObject({
      id: "b37637a0-18d4-4316-a445-2e62415bb3fb",
      status: "completed",
      category: "GROCERY",
      placedAt: "2026-09-21T23:09:58.000Z",
      completedAt: "2026-09-22T00:04:38.000Z",
      store: { name: "Target", address: "512 2nd Ave, New York, NY 10016" },
      itemsMatchSubtotal: true,
    });
    expect(o.items.map((i) => [i.title, i.quantity, i.unitPrice, i.lineTotal])).toEqual([
      ["Cascade Platinum Dishwasher Detergent Liquid, Fresh (75 fl oz)", 1, 14.39, 14.39],
      ["Dealworthy Hdmi High Speed Cable With Ethernet Cable, 6 ft, Black", 1, 10.79, 10.79],
    ]);
    expect(o.fare).toMatchObject({
      subtotal: 25.18,
      tax: 2.98,
      deliveryFee: 0.99,
      serviceFee: 7.4,
      tip: 0,
      discounts: 0,
      total: 36.55,
    });
  });

  test("option add-ons are per unit and multiply by quantity", () => {
    const eggs = page.orders[1].items.find((i) => i.title === "Two Eggs on a Bagel")!;
    expect(eggs).toMatchObject({ quantity: 2, unitPrice: 6.88, optionsPrice: 1.5, lineTotal: 16.76 });
    expect(page.orders[1].itemsMatchSubtotal).toBe(true);
  });

  test("every fixture order's fare buckets sum to its total", () => {
    for (const o of page.orders) {
      const f = o.fare;
      const sum = (f.subtotal ?? 0) + f.tax + f.deliveryFee + f.serviceFee + f.tip + f.discounts;
      expect(Math.round(sum * 100) / 100).toBe(f.total);
    }
  });

  test("an included ingredient priced as an extra is flagged, not trusted", () => {
    // the Happy Meal lists its included patty at its extra-unit price with defaultQuantity 0
    expect(page.orders[2].itemsMatchSubtotal).toBe(false);
  });

  test("receipt line totals, where printed, are authoritative and fix the flag", () => {
    const fixed = withReceiptLineTotals(page.orders[2], [
      { id: "f3f6443a-430c-488f-a76b-d805cebe581b", amount: 16.18 },
      { id: "e4f3ecfe-5938-411d-8bb0-edb92609d70a", amount: 7.49 },
    ]);
    expect(fixed.items.map((i) => [i.lineTotal, i.lineTotalSource])).toEqual([
      [16.18, "receipt"],
      [7.49, "receipt"],
    ]);
    expect(fixed.itemsMatchSubtotal).toBe(true);
  });

  test("legacy receipt lines (no ids) join by title and quantity, each used once", () => {
    const o = page.orders[2]; // the Happy Meal order
    const fixed = withReceiptLineTotals(o, [
      { id: "legacy-0", title: "Hamburger Happy Meal", quantity: 2, amount: 16.18 },
      { id: "legacy-1", title: "10 pc. Chicken McNuggets®", quantity: 1, amount: 7.49 },
    ]);
    expect(fixed.items.map((i) => [i.lineTotal, i.lineTotalSource])).toEqual([
      [16.18, "receipt"],
      [7.49, "receipt"],
    ]);
    expect(fixed.itemsMatchSubtotal).toBe(true);
  });

  test("a legacy line whose title or quantity differs is not applied", () => {
    const o = page.orders[2];
    const fixed = withReceiptLineTotals(o, [{ id: "legacy-0", title: "Hamburger Happy Meal", quantity: 3, amount: 1 }]);
    expect(fixed.items[0].lineTotalSource).toBe("computed");
  });

  test("non-Latin titles keep distinct keys: a line printed for one never lands on the other", () => {
    const o = { ...page.orders[0] };
    o.items = [
      { ...o.items[0], id: "x1", title: "寿司", quantity: 1 },
      { ...o.items[1], id: "x2", title: "拉麺", quantity: 1 },
    ];
    const fixed = withReceiptLineTotals(o, [{ id: "legacy-0", title: "拉麺", quantity: 1, amount: 9.5 }]);
    expect(fixed.items.map((i) => [i.title, i.lineTotalSource])).toEqual([
      ["寿司", "computed"],
      ["拉麺", "receipt"],
    ]);
  });

  test("two order items with the same title and quantity are ambiguous: both stay computed", () => {
    const o = { ...page.orders[0] };
    o.items = [
      { ...o.items[0], id: "a", title: "Latte", quantity: 1, lineTotal: 5 },
      { ...o.items[1], id: "b", title: "Latte", quantity: 1, lineTotal: 6 },
    ];
    const fixed = withReceiptLineTotals(o, [
      { id: "legacy-0", title: "Latte", quantity: 1, amount: 6 },
      { id: "legacy-1", title: "Latte", quantity: 1, amount: 5 },
    ]);
    expect(fixed.items.map((i) => [i.lineTotal, i.lineTotalSource])).toEqual([
      [5, "computed"],
      [6, "computed"],
    ]);
  });

  test("receipts with no printed line amounts leave the order unchanged", () => {
    const o = page.orders[0];
    expect(withReceiptLineTotals(o, [{ id: o.items[0].id, amount: null }])).toBe(o);
  });
});

describe("parseOrder (getPastOrderV1)", () => {
  test("single-order payload parses the same way", () => {
    const o = parseOrder(fixture("past-order.json").order);
    expect(o.id).toBe("b37637a0-18d4-4316-a445-2e62415bb3fb");
    expect(o.fare.total).toBe(36.55);
  });

  test("status and fallbacks on a sparse payload", () => {
    const o = parseOrder({ baseEaterOrder: { uuid: "x", isCancelled: true }, storeInfo: {} });
    expect(o).toMatchObject({
      id: "x",
      status: "cancelled",
      placedAt: null,
      items: [],
      itemsMatchSubtotal: null,
      isOrderCreator: true,
    });
  });
});

describe("options and fares", () => {
  test("only quantity above the included default is charged; nested groups count", () => {
    const item = parseItem({
      title: "Combo",
      price: 1000,
      quantity: 3,
      customizations: [
        {
          title: "Patty",
          childOptions: { options: [{ title: "Beef", price: 200, quantity: 2, defaultQuantity: 1 }] },
        },
        {
          title: "Side",
          childOptions: {
            options: [
              {
                title: "Fries",
                price: 0,
                quantity: 1,
                childCustomizationList: [
                  { title: "Dip", childOptions: { options: [{ title: "Aioli", price: 50, quantity: 1 }] } },
                ],
              },
            ],
          },
        },
      ],
    });
    expect(item.options.map((o) => [o.group, o.title, o.price])).toEqual([
      ["Patty", "Beef", 2],
      ["Side", "Fries", 0],
      ["Dip", "Aioli", 0.5],
    ]);
    expect(item).toMatchObject({ optionsPrice: 2.5, lineTotal: 37.5 });
  });

  test("debit lines are negative and land in discounts", () => {
    const f = parseFare([
      { key: "eats_fare.subtotal", label: "Subtotal", rawValue: 10, type: "credit" },
      { key: "eats.mp.discounts.membership.cash_benefit", label: "Uber One Credits", rawValue: 1.25, type: "debit" },
      { key: "eats_fare.tip", label: "Tip", rawValue: 2, type: "credit" },
      { key: "eats.tax.base", label: "Tax", rawValue: 0.8, type: "credit" },
      { key: "eats.mp.charges.booking_fee", label: "Delivery Fee", rawValue: 0.99, type: "credit" },
      { key: "eats.mp.charges.basket_dependent_fee", label: "Service Fee and Other Fees", rawValue: 3, type: "credit" },
      { key: "eats_fare.total", label: "Total", rawValue: 15.54, type: "credit" },
    ]);
    expect(f).toMatchObject({
      subtotal: 10,
      discounts: -1.25,
      tip: 2,
      tax: 0.8,
      deliveryFee: 0.99,
      serviceFee: 3,
      total: 15.54,
    });
  });

  test("unknown keys are kept as lines but not bucketed", () => {
    expect(fareBucket({ key: "eats.something.new", label: "Bag", amount: 0.1 })).toBeNull();
    expect(parseFare([{ key: "eats.something.new", label: "Bag", rawValue: 0.1, type: "credit" }]).lines).toHaveLength(
      1,
    );
  });
});
