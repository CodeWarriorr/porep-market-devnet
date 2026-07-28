export const EPOCHS_IN_MONTH = 86_400n;
export const BYTES_PER_32_GIB = 32n * 1024n * 1024n * 1024n;

function requireNonNegative(value: bigint, name: string): void {
  if (value < 0n) {
    throw new Error(`${name} must not be negative`);
  }
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return numerator === 0n ? 0n : (numerator - 1n) / denominator + 1n;
}

export function billed32GiBUnits(committedBytes: bigint): bigint {
  requireNonNegative(committedBytes, "committed bytes");
  return ceilDiv(committedBytes, BYTES_PER_32_GIB);
}

export function ratePerEpoch(pricePer32GiBPerMonth: bigint, units: bigint): bigint {
  requireNonNegative(pricePer32GiBPerMonth, "price");
  requireNonNegative(units, "units");
  return ceilDiv(pricePer32GiBPerMonth * units, EPOCHS_IN_MONTH);
}

export function dueAmount(
  pricePer32GiBPerMonth: bigint,
  units: bigint,
  serviceStartEpoch: bigint,
  epoch: bigint,
): bigint {
  requireNonNegative(pricePer32GiBPerMonth, "price");
  requireNonNegative(units, "units");
  if (epoch <= serviceStartEpoch) return 0n;
  return (pricePer32GiBPerMonth * units * (epoch - serviceStartEpoch)) / EPOCHS_IN_MONTH;
}

export function settlementAmount(
  pricePer32GiBPerMonth: bigint,
  units: bigint,
  serviceStartEpoch: bigint,
  fromEpoch: bigint,
  toEpoch: bigint,
): bigint {
  if (toEpoch < fromEpoch) {
    throw new Error("settlement end epoch must not be before start epoch");
  }
  return (
    dueAmount(pricePer32GiBPerMonth, units, serviceStartEpoch, toEpoch)
    - dueAmount(pricePer32GiBPerMonth, units, serviceStartEpoch, fromEpoch)
  );
}

export function networkFee(grossSettlementAmount: bigint): bigint {
  requireNonNegative(grossSettlementAmount, "gross settlement amount");
  return ceilDiv(grossSettlementAmount, 200n);
}

export function netPayeeAmount(grossSettlementAmount: bigint): bigint {
  return grossSettlementAmount - networkFee(grossSettlementAmount);
}
