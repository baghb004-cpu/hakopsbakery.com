import { describe, it, expect } from "vitest";
import {
  detectAddressForm,
  checkCaliforniaDestination,
  quoteShipping,
  shipDateFor,
  arrivalDate,
  isTransitDay,
  daysBetween,
  SERVICES,
} from "../src/lib/carriers";

const CA = { line1: "1 Main St", city: "Cypress", state: "CA", postal_code: "90630", country: "US" };

describe("address form", () => {
  it("spots a PO Box however it is written", () => {
    for (const line of ["PO Box 12", "P.O. Box 4421", "p o box 9", "Post Office Box 100", "POB 7"]) {
      expect(detectAddressForm({ ...CA, line1: line }), line).toBe("po-box");
    }
  });

  it("does not mistake a street for a PO Box", () => {
    // These all contain the letters but are ordinary deliverable addresses.
    for (const line of ["123 Post Road", "45 Box Canyon Dr", "PMB 200", "1 Postal Way"]) {
      expect(detectAddressForm({ ...CA, line1: line }), line).toBe("street");
    }
  });

  it("spots military addresses by state code and by ZIP", () => {
    expect(detectAddressForm({ ...CA, state: "AP", postal_code: "96205" })).toBe("military");
    expect(detectAddressForm({ ...CA, state: "AE", postal_code: "09123" })).toBe("military");
    expect(detectAddressForm({ ...CA, postal_code: "96205" })).toBe("military");
  });

  it("does not treat the top of the California range as military", () => {
    // 96162 is Truckee. Military AP starts at 96200. They look adjacent and
    // a careless range widening would swallow real customers.
    expect(detectAddressForm({ ...CA, postal_code: "96162" })).toBe("street");
  });
});

describe("the California gate", () => {
  it("accepts a real California address", () => {
    const r = checkCaliforniaDestination(CA);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.zip).toBe("90630");
  });

  it("refuses another state", () => {
    const r = checkCaliforniaDestination({ ...CA, state: "NV", postal_code: "89101" });
    expect(r).toMatchObject({ ok: false, reason: "state-not-california" });
  });

  it("refuses when the state and the ZIP disagree", () => {
    // Someone typed CA but a Nevada ZIP. Do not guess which one is right on
    // an order that has already been paid for.
    const r = checkCaliforniaDestination({ ...CA, state: "CA", postal_code: "89101" });
    expect(r).toMatchObject({ ok: false, reason: "state-zip-mismatch" });
  });

  it("is not fooled by Canada, whose country code is also CA", () => {
    const r = checkCaliforniaDestination({ ...CA, country: "CA" });
    expect(r).toMatchObject({ ok: false, reason: "not-us" });
  });

  it("refuses military addresses", () => {
    const r = checkCaliforniaDestination({ ...CA, state: "AP", postal_code: "96205" });
    expect(r).toMatchObject({ ok: false, reason: "military" });
  });

  it("refuses an incomplete address rather than assuming", () => {
    expect(checkCaliforniaDestination(null)).toMatchObject({ ok: false, reason: "missing-address" });
    expect(checkCaliforniaDestination({ ...CA, line1: null })).toMatchObject({ ok: false });
  });
});

describe("the carrier calendar", () => {
  it("knows carriers do not move at the weekend", () => {
    expect(isTransitDay("2026-09-11")).toBe(true); // Friday
    expect(isTransitDay("2026-09-12")).toBe(false); // Saturday
    expect(isTransitDay("2026-09-13")).toBe(false); // Sunday
  });

  it("knows carriers do not move on a federal holiday", () => {
    expect(isTransitDay("2026-11-26")).toBe(false); // Thanksgiving
    expect(isTransitDay("2026-07-03")).toBe(false); // Independence Day observed
  });

  it("hands a Friday bake to the carrier on the Monday", () => {
    // Baked Friday. Nothing moves over the weekend, so it goes Monday.
    expect(shipDateFor("2026-09-11")).toBe("2026-09-14");
  });

  it("steps over Thanksgiving rather than through it", () => {
    // Shipped the Wednesday before. One transit day lands on Thanksgiving,
    // which is not a transit day, so it becomes the Friday.
    expect(arrivalDate("2026-11-25", SERVICES.ups_ground, 1)).toBe("2026-11-27");
  });

  it("waits for a day the service actually delivers on", () => {
    // FedEx Home Delivery runs Tuesday to Saturday. A parcel that completes
    // transit on a Monday sits until Tuesday.
    const arrival = arrivalDate("2026-09-11", SERVICES.fedex_home_delivery, 1);
    expect(arrival).toBe("2026-09-15"); // Tuesday, not Monday the 14th
  });
});

describe("quoting", () => {
  const parcel = { weightOz: 40 };
  const freshness = { bestByDays: 10, marginDays: 2 };

  it("offers every carrier to an ordinary California street address", () => {
    const q = quoteShipping({ address: CA, parcel, bakeDate: "2026-09-11", freshness });
    const carriers = new Set(q.offered.map((o) => o.service.carrier));
    expect(carriers).toContain("usps");
    expect(carriers).toContain("ups");
    expect(carriers).toContain("fedex");
  });

  it("offers only USPS to a PO Box, and says why the others are missing", () => {
    const q = quoteShipping({
      address: { ...CA, line1: "PO Box 812" },
      parcel,
      bakeDate: "2026-09-11",
      freshness,
    });
    expect(q.offered.every((o) => o.service.carrier === "usps")).toBe(true);
    expect(q.offered.length).toBeGreaterThan(0);

    const refusedCarriers = q.rejected
      .filter((r) => r.reason === "po-box-needs-usps")
      .map((r) => r.service.carrier);
    expect(refusedCarriers).toContain("ups");
    expect(refusedCarriers).toContain("fedex");
  });

  it("does not send a box that would arrive past its best", () => {
    const q = quoteShipping({
      address: CA,
      parcel,
      bakeDate: "2026-09-11",
      freshness: { bestByDays: 4, marginDays: 2 },
    });
    expect(q.offered).toHaveLength(0);
    // Not every refusal is about freshness: FedEx Ground is a commercial
    // service going to a house, and it is refused for that first. What
    // matters is that nothing is offered and that freshness did the work
    // for the services that were otherwise eligible.
    expect(q.rejected.some((r) => r.reason === "arrives-stale")).toBe(true);
    expect(
      q.rejected
        .filter((r) => r.reason !== "wrong-destination-type")
        .every((r) => r.reason === "arrives-stale"),
    ).toBe(true);
  });

  it("measures freshness from the oven, not from the carrier collection", () => {
    const q = quoteShipping({ address: CA, parcel, bakeDate: "2026-09-11", freshness });
    const priority = q.offered.find((o) => o.service.code === "usps_priority");
    expect(priority).toBeDefined();
    // Baked Friday, collected Monday, worst case arrival Wednesday.
    expect(priority!.daysInTransitWorstCase).toBe(daysBetween("2026-09-11", priority!.arrivalLatest));
    expect(priority!.daysInTransitWorstCase).toBeGreaterThanOrEqual(3);
  });

  it("refuses a parcel over a carrier weight limit", () => {
    const q = quoteShipping({
      address: CA,
      parcel: { weightOz: 80 * 16 }, // over the USPS 70 lb ceiling
      bakeDate: "2026-09-11",
      freshness,
    });
    const tooHeavy = q.rejected.filter((r) => r.reason === "too-heavy").map((r) => r.service.carrier);
    expect(tooHeavy).toContain("usps");
    expect(q.offered.some((o) => o.service.carrier === "ups")).toBe(true);
  });

  it("sorts the soonest arrival first, because a customer is picking a date", () => {
    const q = quoteShipping({ address: CA, parcel, bakeDate: "2026-09-11", freshness });
    const dates = q.offered.map((o) => o.arrivalLatest);
    expect([...dates].sort()).toEqual(dates);
  });
});
