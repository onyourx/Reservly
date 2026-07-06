/** The Reservly mark (brand book v1.0): two slot bars in a rounded emerald
 *  tile, the lower one filled and checked — a reservation confirmed. */
export function LogoMark({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 96 96" aria-hidden="true">
      <rect width="96" height="96" rx="21" fill="#12A46B" />
      <rect x="18" y="28" width="60" height="17" rx="8.5" fill="#fff" fillOpacity="0.38" />
      <rect x="18" y="51" width="60" height="17" rx="8.5" fill="#fff" />
      <path d="M30 59.5 L36.5 66 L49 53.5" stroke="#12A46B" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
