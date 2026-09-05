/**
 * The Ctrl+Y mark.
 *
 * A key legend: the Y cut into a keycap. The Y is drawn as two pieces — one arm
 * arrives on its own, the other carries through into the stem — so the glyph
 * says what the product does: several readings of a document converge into one
 * list. The seam between them is a hairline at rail size and closes up at
 * favicon size, which is the point; the mark degrades to a plain Y rather than
 * to mush.
 *
 * Geometry sits on a 32 grid — cap 7.8, baseline 24.2, stem 14.3–17.7, seam
 * offset 1.30 in x. The two limbs are parallel by construction and the outline
 * is an ordinary symmetric Y: the seam only cuts the interior, so the mark's
 * silhouette never goes lopsided. Nudging one number without re-deriving the
 * rest will bend the limbs. public/favicon.svg carries the same two paths at a
 * larger optical size; change both together.
 */

/* The arm that arrives. */
const ARM = 'M7.6 7.8 L11.7 7.8 L16 14.4 L14.3 17.01 L14.3 18.08 Z';
/* The arm that carries the stem down to the baseline. */
const STEM = 'M21.6 7.8 L24.4 7.8 L17.7 18.08 L17.7 24.2 L14.3 24.2 L14.3 19 Z';

export function LogoMark({ size = 26 }: { size?: number }) {
  return (
    <svg className="logo-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect className="logo-key" width="32" height="32" rx="8" />
      <path className="logo-glyph" d={ARM} />
      <path className="logo-glyph" d={STEM} />
    </svg>
  );
}

/**
 * Mark and wordmark locked up. The name is a key chord, so it is set in the
 * mono face this system already reserves for identifiers; the plus drops a step
 * in colour so the two keys read as two keys.
 */
export default function Logo({ size }: { size?: number }) {
  return (
    <span className="logo" aria-label="Ctrl+Y">
      <LogoMark size={size} />
      <span className="logo-word" aria-hidden>
        Ctrl<span className="logo-plus">+</span>Y
      </span>
    </span>
  );
}
