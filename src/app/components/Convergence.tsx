/**
 * The count of turns — the one number the fund manager said he actually cares
 * about. Earlier passes recede; the current count is the hero, and turns mint
 * when a review reached zero.
 */

export default function Convergence({ passes }: { passes: number[] }) {
  const last = passes[passes.length - 1];
  const prior = passes.slice(0, -1);
  const landed = last === 0;

  return (
    <span className="convergence" aria-label={`Passes: ${passes.join(', then ')}`}>
      {prior.map((n, i) => (
        <span key={i} className="cv-prior">
          {n}
          <span className="cv-sep" aria-hidden>
            →
          </span>
        </span>
      ))}
      <b className={landed ? 'cv-last landed' : 'cv-last'}>{last}</b>
      <span className="cv-unit">{landed ? 'closed' : 'open'}</span>
    </span>
  );
}
