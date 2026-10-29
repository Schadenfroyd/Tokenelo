/** Compact display only; exact comparison values retain the original finite JS number. */
export function evidenceNumber(value: number | null, kind: 'usd' | 'count'): {
  text: string;
  exact: string | null;
  rounded: boolean;
} {
  if (value === null || !Number.isFinite(value)
    || kind === 'count' && (!Number.isSafeInteger(value) || value < 0)) {
    return { text: 'Unknown', exact: null, rounded: false };
  }
  const magnitude = Math.abs(value);
  const body = magnitude !== 0 && (magnitude < 0.0001 || magnitude >= 1_000_000)
    ? magnitude.toExponential(2).replace(/(\.\d*?)0+e/, '$1e').replace('.e', 'e')
    : Number(magnitude.toPrecision(6)).toString();
  const rounded = Number(body) !== magnitude;
  return {
    text: `${rounded ? '≈' : ''}${value < 0 ? '-' : ''}${kind === 'usd' ? '$' : ''}${body}`,
    exact: String(value),
    rounded,
  };
}
