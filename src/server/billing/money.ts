/** Credits are stored in thousandths. Never multiply money using binary floats. */
export function creditsToMilli(value: string): number {
  if (!/^\d+(\.\d{1,3})?$/.test(value))
    throw new Error('Credits must have at most three decimal places');
  const [whole, fraction = ''] = value.split('.');
  const result = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
  if (result > 1_000_000_000n) throw new Error('Credit value exceeds supported range');
  return Number(result);
}

/** ffprobe emits a decimal string in seconds. Round sub-microsecond precision up. */
export function secondsToMicros(value: string): number {
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error('Invalid media duration');
  const [whole, fraction = ''] = value.split('.');
  let micros = BigInt(whole) * 1_000_000n + BigInt(fraction.slice(0, 6).padEnd(6, '0'));
  if (/[1-9]/.test(fraction.slice(6))) micros += 1n;
  if (micros <= 0n || micros > 3_600_000_000n)
    throw new Error('Media duration is outside supported bounds');
  return Number(micros);
}

export function costForMicros(durationMicros: number, rateMilli: number): number {
  if (
    !Number.isSafeInteger(durationMicros) ||
    durationMicros <= 0 ||
    !Number.isSafeInteger(rateMilli) ||
    rateMilli <= 0
  ) {
    throw new Error('Invalid pricing input');
  }
  const result = (BigInt(durationMicros) * BigInt(rateMilli) + 999_999n) / 1_000_000n;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Price exceeds supported range');
  return Number(result);
}
